from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from math import log, sqrt
from typing import Iterable

import numpy as np

from .demo_data import ANIME, DemoRating, build_training_ratings


MODEL_VERSION = "surprise-userknn-demo-0.1"
DATA_VERSION = "fictional-demo-2026-07"


@dataclass(frozen=True)
class Neighbor:
    user_id: int
    similarity: float
    overlap: int
    contributions: tuple[tuple[int, float], ...]


class SurpriseUserKNN:
    """User-centered KNN with residual, IUF and event-surprise weighting."""

    def __init__(
        self,
        ratings: Iterable[DemoRating] | None = None,
        overlap_min: int = 3,
        shrinkage: float = 10.0,
        neighbor_count: int = 50,
        surprise_mix: float = 0.5,
        uncertainty_penalty: float = 0.25,
    ) -> None:
        self.ratings = list(ratings or build_training_ratings())
        self.overlap_min = overlap_min
        self.shrinkage = shrinkage
        self.neighbor_count = neighbor_count
        self.surprise_mix = surprise_mix
        self.uncertainty_penalty = uncertainty_penalty
        self.anime = {item["mal_id"]: item for item in ANIME}
        self._fit()

    @staticmethod
    def _bucket(value: float) -> int:
        if value <= -0.7:
            return 0
        if value >= 0.7:
            return 2
        return 1

    def _fit(self) -> None:
        by_user: dict[int, dict[int, float]] = defaultdict(dict)
        by_item: dict[int, list[float]] = defaultdict(list)
        for record in self.ratings:
            if 1 <= record.rating <= 10:
                by_user[record.user_id][record.mal_id] = record.rating
                by_item[record.mal_id].append(record.rating)

        all_scores = np.array([r.rating for r in self.ratings], dtype=np.float64)
        self.global_mean = float(all_scores.mean())
        self.user_bias = {
            uid: (sum(scores.values()) - len(scores) * self.global_mean)
            / (len(scores) + 10)
            for uid, scores in by_user.items()
        }
        self.item_bias = {}
        for mal_id, scores in by_item.items():
            centered = [
                score - self.global_mean - self.user_bias[uid]
                for uid, user_scores in by_user.items()
                if (score := user_scores.get(mal_id)) is not None
            ]
            self.item_bias[mal_id] = sum(centered) / (len(centered) + 15)

        self.residuals: dict[int, dict[int, float]] = defaultdict(dict)
        self.scales: dict[int, float] = {}
        for uid, scores in by_user.items():
            raw = {
                mal_id: score
                - self.global_mean
                - self.user_bias[uid]
                - self.item_bias.get(mal_id, 0)
                for mal_id, score in scores.items()
            }
            scale = max(float(np.std(list(raw.values()))), 0.5)
            self.scales[uid] = scale
            self.residuals[uid] = {
                mal_id: value / scale for mal_id, value in raw.items()
            }

        user_count = len(self.residuals)
        self.iuf = {
            mal_id: log((user_count + 1) / (len(scores) + 1))
            for mal_id, scores in by_item.items()
        }
        self.item_rating_counts = {
            mal_id: len(scores) for mal_id, scores in by_item.items()
        }
        bucket_counts: dict[int, Counter[int]] = defaultdict(Counter)
        for residuals in self.residuals.values():
            for mal_id, value in residuals.items():
                bucket_counts[mal_id][self._bucket(value)] += 1
        self.surprise = {}
        for mal_id, counts in bucket_counts.items():
            total = sum(counts.values())
            for bucket in range(3):
                self.surprise[(mal_id, bucket)] = -log(
                    (counts[bucket] + 1) / (total + 3)
                )
        self.by_user_scores = by_user

    def _target_residuals(self, ratings: dict[int, float]) -> dict[int, float]:
        if not ratings:
            return {}
        target_mean = float(np.mean(list(ratings.values())))
        target_bias = (sum(ratings.values()) - len(ratings) * self.global_mean) / (
            len(ratings) + 10
        )
        raw = {
            mal_id: rating
            - self.global_mean
            - target_bias
            - self.item_bias.get(mal_id, target_mean - self.global_mean)
            for mal_id, rating in ratings.items()
        }
        scale = max(float(np.std(list(raw.values()))), 0.5)
        return {mal_id: value / scale for mal_id, value in raw.items()}

    def neighbors(self, ratings: dict[int, float]) -> list[Neighbor]:
        target = self._target_residuals(ratings)
        result: list[Neighbor] = []
        for uid, other in self.residuals.items():
            common = set(target).intersection(other)
            if len(common) < self.overlap_min:
                continue
            numerator = 0.0
            left = 0.0
            right = 0.0
            contributions: list[tuple[int, float]] = []
            for mal_id in common:
                bucket = self._bucket(target[mal_id])
                surprise = self.surprise.get((mal_id, bucket), 0.0)
                rarity = self.iuf.get(mal_id, 0.0)
                weight = 1.0 + (1 - self.surprise_mix) * rarity
                weight += self.surprise_mix * surprise
                product = weight * target[mal_id] * other[mal_id]
                numerator += product
                left += weight * target[mal_id] ** 2
                right += weight * other[mal_id] ** 2
                contributions.append((mal_id, product))
            if left <= 0 or right <= 0:
                continue
            cosine = numerator / sqrt(left * right)
            similarity = len(common) / (len(common) + self.shrinkage) * cosine
            if similarity > 0:
                contributions.sort(key=lambda item: abs(item[1]), reverse=True)
                result.append(
                    Neighbor(
                        uid,
                        similarity,
                        len(common),
                        tuple(contributions[:3]),
                    )
                )
        result.sort(key=lambda item: item.similarity, reverse=True)
        return result[: self.neighbor_count]

    def recommend(
        self,
        ratings: dict[int, float],
        excluded: set[int] | None = None,
        limit: int = 20,
        min_support: int = 5,
        allow_sequels: bool = True,
        formats: list[str] | None = None,
    ) -> list[dict]:
        excluded = set(excluded or set()).union(ratings)
        target_residuals = self._target_residuals(ratings)
        neighbors = self.neighbors(ratings)
        candidate_votes: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for neighbor in neighbors:
            for mal_id, residual in self.residuals[neighbor.user_id].items():
                if mal_id not in excluded:
                    candidate_votes[mal_id].append(
                        (neighbor.similarity, residual)
                    )

        output: list[dict] = []
        for mal_id, votes in candidate_votes.items():
            anime = self.anime.get(mal_id)
            if not anime or len(votes) < min_support:
                continue
            if formats and anime["format"] not in formats:
                continue
            if not allow_sequels and mal_id == 1112 and 1105 not in ratings:
                continue
            weights = np.array([abs(v[0]) for v in votes], dtype=np.float64)
            values = np.array([v[1] for v in votes], dtype=np.float64)
            weight_sum = float(weights.sum())
            if weight_sum <= 0:
                continue
            estimate = float(np.dot(weights, values) / weight_sum)
            variance = float(np.dot(weights, (values - estimate) ** 2) / weight_sum)
            neff = float(weight_sum**2 / max(float(np.dot(weights, weights)), 1e-9))
            if neff < 3:
                continue
            rank_score = estimate - self.uncertainty_penalty * sqrt(
                variance / neff
            )
            affinity = int(np.clip(round(50 + 25 * rank_score), 1, 99))
            confidence = (
                "高"
                if len(votes) >= 15 and neff >= 8
                else "中"
                if len(votes) >= 8 and neff >= 5
                else "低"
            )

            evidence_scores: dict[int, float] = defaultdict(float)
            for neighbor in neighbors:
                if mal_id not in self.residuals[neighbor.user_id]:
                    continue
                for common_id, contribution in neighbor.contributions:
                    if common_id in target_residuals:
                        evidence_scores[common_id] += (
                            neighbor.similarity * contribution
                        )
            evidence = []
            for evidence_id, score in sorted(
                evidence_scores.items(),
                key=lambda item: abs(item[1]),
                reverse=True,
            )[:3]:
                title = self.anime[evidence_id]["title_zh"]
                target_score = ratings[evidence_id]
                signal = (
                    "共同喜欢低关注作品"
                    if target_residuals[evidence_id] > 0.7
                    else "共同低于常见评价"
                    if target_residuals[evidence_id] < -0.7
                    else "评价走势接近"
                )
                evidence.append(
                    {
                        "mal_id": evidence_id,
                        "title": title,
                        "your_rating": target_score,
                        "signal": signal,
                        "contribution": round(float(score), 4),
                    }
                )

            neighbor_scores = [
                self.by_user_scores[n.user_id][mal_id]
                for n in neighbors
                if mal_id in self.by_user_scores[n.user_id]
            ]
            distribution = {
                "1-4": sum(score <= 4 for score in neighbor_scores),
                "5-6": sum(5 <= score <= 6 for score in neighbor_scores),
                "7-8": sum(7 <= score <= 8 for score in neighbor_scores),
                "9-10": sum(score >= 9 for score in neighbor_scores),
            }
            lead = evidence[0]["title"] if evidence else "你的高区分度评分"
            risk = (
                "邻居意见有明显分歧，亲和度可能波动。"
                if variance > 0.8
                else "样本集中，仍建议结合题材和观看时长判断。"
            )
            output.append(
                {
                    "anime": anime,
                    "rank_score": round(rank_score, 5),
                    "affinity": affinity,
                    "confidence": confidence,
                    "support": len(votes),
                    "effective_sample_size": round(neff, 2),
                    "reason": f"与你在《{lead}》上的评价结构最接近。",
                    "evidence": evidence,
                    "neighbor_distribution": distribution,
                    "risk": risk,
                    "relation_notice": (
                        "需要先完成《轨道尽头》"
                        if mal_id == 1112
                        else None
                    ),
                }
            )
        output.sort(key=lambda item: item["rank_score"], reverse=True)
        return output[:limit]
