from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np

from backend.production_recommender import DiskBackedUserKNN
from backend.training.augment_artifacts import add_rating_means


@dataclass(frozen=True)
class EvaluationCase:
    user_idx: int
    profile: dict[int, float]
    profile_item_indices: set[int]
    relevant_item_indices: set[int]
    popularity_segment: str
    popularity_score: float


def _ndcg(recommended: list[int], relevant: set[int], k: int) -> float:
    gains = [
        1.0 / math.log2(rank + 2)
        for rank, item in enumerate(recommended[:k])
        if item in relevant
    ]
    ideal_count = min(len(relevant), k)
    if not ideal_count:
        return 0.0
    ideal = sum(1.0 / math.log2(rank + 2) for rank in range(ideal_count))
    return sum(gains) / ideal


def _metrics(
    recommended: list[int],
    relevant: set[int],
    profile_items: set[int],
) -> dict[str, float]:
    result: dict[str, float] = {}
    for k in (10, 20):
        top = recommended[:k]
        hits = len(set(top).intersection(relevant))
        result[f"ndcg@{k}"] = _ndcg(recommended, relevant, k)
        result[f"recall@{k}"] = hits / len(relevant)
    result["hitrate@10"] = float(
        bool(set(recommended[:10]).intersection(relevant))
    )
    result["seen_leakage@20"] = (
        len(set(recommended[:20]).intersection(profile_items))
        / max(min(len(recommended), 20), 1)
    )
    result["result_count"] = float(min(len(recommended), 20))
    return result


def _bootstrap_difference(
    challenger: np.ndarray,
    baseline: np.ndarray,
    seed: int,
    repetitions: int = 10_000,
) -> dict[str, float]:
    if len(challenger) != len(baseline) or not len(challenger):
        raise ValueError("bootstrap 输入数量不一致或为空。")
    difference = challenger - baseline
    random = np.random.default_rng(seed)
    samples = random.integers(
        0, len(difference), size=(repetitions, len(difference))
    )
    estimates = difference[samples].mean(axis=1)
    return {
        "mean": float(difference.mean()),
        "ci95_lower": float(np.quantile(estimates, 0.025)),
        "ci95_upper": float(np.quantile(estimates, 0.975)),
        "repetitions": repetitions,
    }


def _build_cases(
    model: DiskBackedUserKNN,
    requested_users: int,
    seed: int,
    minimum_profile_ratings: int,
    holdout_fraction: float,
    maximum_holdout: int,
) -> list[EvaluationCase]:
    counts = np.diff(model.csr_indptr)
    eligible_users = np.flatnonzero(counts >= minimum_profile_ratings)
    random = np.random.default_rng(seed)
    random.shuffle(eligible_users)

    cases: list[EvaluationCase] = []
    for user_idx in eligible_users:
        start = int(model.csr_indptr[user_idx])
        stop = int(model.csr_indptr[user_idx + 1])
        items = np.asarray(model.csr_indices[start:stop], dtype=np.int32)
        ratings = np.asarray(model.csr_ratings[start:stop], dtype=np.float32)
        order = np.arange(len(items))
        user_random = np.random.default_rng(seed ^ int(user_idx))
        user_random.shuffle(order)
        holdout_count = min(
            maximum_holdout,
            max(5, int(round(len(items) * holdout_fraction))),
        )
        holdout_positions = order[:holdout_count]
        profile_positions = order[holdout_count:]
        relevant = set(
            int(item)
            for item, rating in zip(
                items[holdout_positions],
                ratings[holdout_positions],
                strict=True,
            )
            if rating >= 8
        )
        if not relevant or len(profile_positions) < 20:
            continue
        profile_items = items[profile_positions]
        profile = {
            int(model.mal_ids[item]): float(rating)
            for item, rating in zip(
                profile_items,
                ratings[profile_positions],
                strict=True,
            )
        }
        mean_log_popularity = float(
            np.log1p(model.item_counts[profile_items]).mean()
        )
        cases.append(
            EvaluationCase(
                user_idx=int(user_idx),
                profile=profile,
                profile_item_indices=set(map(int, profile_items)),
                relevant_item_indices=relevant,
                popularity_segment="unassigned",
                popularity_score=mean_log_popularity,
            )
        )
        if len(cases) >= requested_users:
            break
    if len(cases) < requested_users:
        raise RuntimeError(
            f"只构造出 {len(cases)} 个有效评测用户，预期 {requested_users}。"
        )
    ranked = sorted(
        range(len(cases)), key=lambda index: cases[index].popularity_score
    )
    assigned = list(cases)
    for rank, index in enumerate(ranked):
        fraction = rank / len(ranked)
        segment = (
            "LowPop"
            if fraction < 1 / 3
            else "MedPop"
            if fraction < 2 / 3
            else "HighPop"
        )
        assigned[index] = replace(
            assigned[index], popularity_segment=segment
        )
    return assigned


def _bayesian_order(model: DiskBackedUserKNN) -> np.ndarray:
    means = np.load(model.root / "item_rating_mean.npy", mmap_mode="r")
    prior_weight = 50.0
    scores = (
        model.item_counts * means + prior_weight * model.global_mean
    ) / (model.item_counts + prior_weight)
    eligible = model.item_counts >= 20
    return np.flatnonzero(eligible)[
        np.argsort(scores[eligible], kind="stable")[::-1]
    ]


def _recommend_indices(
    model: DiskBackedUserKNN,
    case: EvaluationCase,
    limit: int,
    min_support: int,
) -> list[int]:
    records = model.recommend(
        case.profile,
        limit=limit,
        min_support=min_support,
        excluded_user_indices={case.user_idx},
    )
    return [
        model._mal_to_item[int(record["anime"]["mal_id"])]
        for record in records
    ]


def _aggregate(
    rows: list[dict[str, float]],
    recommendations: list[list[int]],
    segments: list[str],
    model: DiskBackedUserKNN,
) -> dict:
    metric_names = rows[0].keys()
    aggregate = {
        name: float(np.mean([row[name] for row in rows]))
        for name in metric_names
    }
    eligible = set(map(int, np.flatnonzero(model.item_counts >= 20)))
    unique_recommended = set().union(*map(set, recommendations))
    popularity_threshold = float(
        np.quantile(model.item_counts[list(eligible)], 0.8)
    )
    long_tail = {
        item for item in eligible
        if model.item_counts[item] <= popularity_threshold
    }
    aggregate["catalog_coverage"] = (
        len(unique_recommended.intersection(eligible)) / len(eligible)
    )
    aggregate["long_tail_coverage"] = (
        len(unique_recommended.intersection(long_tail)) / len(long_tail)
    )
    aggregate["unique_recommended_items"] = len(unique_recommended)
    segment_metrics = {}
    for segment in ("LowPop", "MedPop", "HighPop"):
        indices = [
            index for index, value in enumerate(segments)
            if value == segment
        ]
        segment_metrics[segment] = {
            "users": len(indices),
            "ndcg@10": (
                float(np.mean([rows[index]["ndcg@10"] for index in indices]))
                if indices
                else None
            ),
        }
    return {
        "aggregate": aggregate,
        "segments": segment_metrics,
        "per_user_ndcg@10": [row["ndcg@10"] for row in rows],
    }


def evaluate(
    artifact_directory: Path,
    output: Path,
    users: int,
    seed: int,
    overlap_min: int,
    shrinkage: float,
    neighbor_count: int,
    surprise_mix: float,
    uncertainty_penalty: float,
    min_support: int,
) -> dict:
    add_rating_means(artifact_directory)
    common = {
        "artifact_directory": artifact_directory,
        "overlap_min": overlap_min,
        "shrinkage": shrinkage,
        "neighbor_count": neighbor_count,
        "uncertainty_penalty": uncertainty_penalty,
    }
    mean_model = DiskBackedUserKNN(
        **common, similarity_mode="mean_centered"
    )
    surprise_model = DiskBackedUserKNN(
        **common,
        similarity_mode="surprise",
        surprise_mix=surprise_mix,
    )
    cases = _build_cases(
        mean_model,
        requested_users=users,
        seed=seed,
        minimum_profile_ratings=50,
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    popularity_order = _bayesian_order(mean_model)
    method_rows: dict[str, list[dict[str, float]]] = {
        "bayesian_popularity": [],
        "mean_centered_userknn": [],
        "surprise_weighted_userknn": [],
    }
    method_recommendations: dict[str, list[list[int]]] = {
        name: [] for name in method_rows
    }
    timings = {name: [] for name in method_rows}

    for position, case in enumerate(cases, start=1):
        start = time.perf_counter()
        popular = [
            int(item)
            for item in popularity_order
            if int(item) not in case.profile_item_indices
        ][:20]
        timings["bayesian_popularity"].append(time.perf_counter() - start)

        start = time.perf_counter()
        mean_recommendations = _recommend_indices(
            mean_model, case, 20, min_support
        )
        timings["mean_centered_userknn"].append(
            time.perf_counter() - start
        )

        start = time.perf_counter()
        surprise_recommendations = _recommend_indices(
            surprise_model, case, 20, min_support
        )
        timings["surprise_weighted_userknn"].append(
            time.perf_counter() - start
        )

        recommendations_by_method = {
            "bayesian_popularity": popular,
            "mean_centered_userknn": mean_recommendations,
            "surprise_weighted_userknn": surprise_recommendations,
        }
        for method, recommended in recommendations_by_method.items():
            method_recommendations[method].append(recommended)
            method_rows[method].append(
                _metrics(
                    recommended,
                    case.relevant_item_indices,
                    case.profile_item_indices,
                )
            )
        print(
            f"[{position}/{len(cases)}] user_idx={case.user_idx}",
            flush=True,
        )

    segments = [case.popularity_segment for case in cases]
    methods = {
        method: _aggregate(
            rows,
            method_recommendations[method],
            segments,
            mean_model,
        )
        for method, rows in method_rows.items()
    }
    for method in methods:
        method_times = np.asarray(timings[method])
        methods[method]["timing_seconds"] = {
            "median": float(np.median(method_times)),
            "p95": float(np.quantile(method_times, 0.95)),
        }

    comparison = _bootstrap_difference(
        np.asarray(
            methods["surprise_weighted_userknn"]["per_user_ndcg@10"]
        ),
        np.asarray(methods["mean_centered_userknn"]["per_user_ndcg@10"]),
        seed=seed,
    )
    mean_ndcg = methods["mean_centered_userknn"]["aggregate"]["ndcg@10"]
    comparison["relative_change"] = (
        comparison["mean"] / mean_ndcg if mean_ndcg else None
    )
    result = {
        "created_at": datetime.now(UTC).isoformat(),
        "artifact": str(artifact_directory.resolve()),
        "artifact_created_at": mean_model.manifest["created_at"],
        "evaluation": {
            "users": users,
            "seed": seed,
            "split": "deterministic per-user 80/20, maximum 20 held out",
            "relevance": "held-out rating >= 8",
            "minimum_profile_ratings_before_split": 50,
        },
        "parameters": {
            "overlap_min": overlap_min,
            "shrinkage": shrinkage,
            "neighbor_count": neighbor_count,
            "surprise_mix": surprise_mix,
            "uncertainty_penalty": uncertainty_penalty,
            "min_support": min_support,
        },
        "methods": methods,
        "surprise_vs_mean_centered_ndcg@10": comparison,
        "sequel_order_error_rate": {
            "value": None,
            "reason": "当前数据只有 sequel 布尔字段，没有完整前后作关系边，不能据此计算。",
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    temporary_output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_output.replace(output)
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Evaluate recommenders with deterministic held-out ratings."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--users", type=int, default=100)
    result.add_argument("--seed", type=int, default=20260727)
    result.add_argument("--overlap-min", type=int, default=10)
    result.add_argument("--shrinkage", type=float, default=25.0)
    result.add_argument("--neighbor-count", type=int, default=100)
    result.add_argument("--surprise-mix", type=float, default=0.5)
    result.add_argument("--uncertainty-penalty", type=float, default=0.25)
    result.add_argument("--min-support", type=int, default=5)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = evaluate(
        artifact_directory=args.artifact_directory,
        output=args.output,
        users=args.users,
        seed=args.seed,
        overlap_min=args.overlap_min,
        shrinkage=args.shrinkage,
        neighbor_count=args.neighbor_count,
        surprise_mix=args.surprise_mix,
        uncertainty_penalty=args.uncertainty_penalty,
        min_support=args.min_support,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
