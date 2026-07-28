from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import polars as pl


@dataclass(frozen=True)
class IndexedNeighbor:
    user_idx: int
    similarity: float
    overlap: int


class DiskBackedUserKNN:
    """Memory-mapped positive UserKNN for the full ratings corpus."""

    GENRE_LABELS = {
        "action": "动作",
        "adventure": "冒险",
        "avant garde": "先锋",
        "boys love": "耽美",
        "comedy": "喜剧",
        "coming of age": "成长",
        "crime": "犯罪",
        "cute girls doing cute things": "萌系日常",
        "dark fantasy": "黑暗奇幻",
        "detective": "侦探",
        "drama": "剧情",
        "ecchi": "卖肉",
        "family life": "家庭",
        "fantasy": "奇幻",
        "female ensemble": "女性群像",
        "friendship": "友情",
        "game": "游戏",
        "girls love": "百合",
        "gourmet": "美食",
        "historical": "历史",
        "horror": "恐怖",
        "idol": "偶像",
        "isekai": "异世界",
        "iyashikei": "治愈",
        "magic": "魔法",
        "magical girl": "魔法少女",
        "martial arts": "武术",
        "mecha": "机甲",
        "military": "军事",
        "music": "音乐",
        "mystery": "悬疑",
        "mythology": "神话",
        "parody": "恶搞",
        "post-apocalyptic": "末世",
        "psychological": "心理",
        "romance": "恋爱",
        "samurai": "武士",
        "school": "校园",
        "sci-fi": "科幻",
        "slice of life": "日常",
        "space": "太空",
        "sports": "运动",
        "supernatural": "超自然",
        "survival": "生存",
        "suspense": "惊悚",
        "time travel": "时间旅行",
        "urban fantasy": "都市奇幻",
        "vampire": "吸血鬼",
    }
    TAG_ALIASES = {
        "action": "action",
        "adventure": "adventure",
        "avant garde": "avant garde",
        "boys love": "boys love",
        "shounen ai": "boys love",
        "comedy": "comedy",
        "coming of age": "coming of age",
        "coming-of-age": "coming of age",
        "crime": "crime",
        "cute girls doing cute things": "cute girls doing cute things",
        "cgdct": "cute girls doing cute things",
        "dark fantasy": "dark fantasy",
        "detective": "detective",
        "detectives": "detective",
        "drama": "drama",
        "ecchi": "ecchi",
        "family life": "family life",
        "fantasy": "fantasy",
        "primarily female cast": "female ensemble",
        "predominantly female cast": "female ensemble",
        "female ensemble": "female ensemble",
        "friendship": "friendship",
        "game": "game",
        "games": "game",
        "girls love": "girls love",
        "shoujo ai": "girls love",
        "yuri": "girls love",
        "gourmet": "gourmet",
        "cooking": "gourmet",
        "historical": "historical",
        "horror": "horror",
        "idol": "idol",
        "idols": "idol",
        "isekai": "isekai",
        "iyashikei": "iyashikei",
        "healing": "iyashikei",
        "magic": "magic",
        "magical girl": "magical girl",
        "mahou shoujo": "magical girl",
        "martial arts": "martial arts",
        "mecha": "mecha",
        "military": "military",
        "music": "music",
        "mystery": "mystery",
        "mythology": "mythology",
        "parody": "parody",
        "post-apocalyptic": "post-apocalyptic",
        "post apocalyptic": "post-apocalyptic",
        "psychological": "psychological",
        "romance": "romance",
        "samurai": "samurai",
        "school": "school",
        "school life": "school",
        "high school": "school",
        "sci-fi": "sci-fi",
        "sci fi": "sci-fi",
        "science fiction": "sci-fi",
        "science-fiction": "sci-fi",
        "slice of life": "slice of life",
        "daily life": "slice of life",
        "space": "space",
        "sports": "sports",
        "supernatural": "supernatural",
        "survival": "survival",
        "suspense": "suspense",
        "thriller": "suspense",
        "time travel": "time travel",
        "urban fantasy": "urban fantasy",
        "vampire": "vampire",
        "vampires": "vampire",
    }
    TAG_SPECIFICITY = {
        "action": 0.72,
        "adventure": 0.78,
        "comedy": 0.68,
        "drama": 0.68,
        "fantasy": 0.72,
        "romance": 0.78,
        "sci-fi": 0.82,
        "supernatural": 0.82,
        "cute girls doing cute things": 1.8,
        "female ensemble": 1.1,
        "girls love": 2.0,
        "iyashikei": 1.7,
        "magical girl": 1.55,
        "school": 0.9,
        "slice of life": 1.1,
    }

    def __init__(
        self,
        artifact_directory: str | Path,
        overlap_min: int = 10,
        shrinkage: float = 25.0,
        neighbor_count: int = 100,
        surprise_mix: float = 0.5,
        uncertainty_penalty: float = 0.25,
        candidate_shrinkage: float = 10.0,
        ancillary_penalty: float = 0.45,
        residual_clip: float = 2.0,
        positive_signal_weight: float = 2.0,
        negative_signal_weight: float = 0.25,
        neutral_signal_weight: float = 0.5,
        absolute_preference_weight: float = 0.75,
        anchor_neighbor_quota: int = 4,
        ranking_mode: Literal["residual", "mean_centered"] = "residual",
        similarity_mode: Literal[
            "mean_centered", "residual", "surprise"
        ] = "surprise",
        title_mapping_path: str | Path | None = None,
    ) -> None:
        self.root = Path(artifact_directory)
        self.manifest = json.loads(
            (self.root / "manifest.json").read_text(encoding="utf-8")
        )
        self.catalog = pl.read_parquet(self.root / "catalog.parquet").sort(
            "anime_id"
        )
        self.title_overrides = self._load_title_overrides(
            Path(title_mapping_path) if title_mapping_path else None
        )
        self.catalog_formats = self.catalog["format"].to_numpy()
        self.catalog_sequels = self.catalog["sequel"].to_numpy()
        self.catalog_series_keys = np.asarray(
            [
                self._series_key(title)
                for title in self.catalog["title"].to_list()
            ],
            dtype=object,
        )
        self.catalog_ancillary = np.asarray(
            [
                self._is_ancillary(format_name, title)
                for format_name, title in zip(
                    self.catalog["format"].to_list(),
                    self.catalog["title"].to_list(),
                    strict=True,
                )
            ],
            dtype=bool,
        )
        self.catalog_inferred_continuations = np.asarray(
            [
                self._looks_like_continuation(title)
                for title in self.catalog["title"].to_list()
            ],
            dtype=bool,
        )
        self.catalog_requires_series_context = np.asarray(
            [
                self._requires_series_context(format_name, title)
                for format_name, title in zip(
                    self.catalog["format"].to_list(),
                    self.catalog["title"].to_list(),
                    strict=True,
                )
            ],
            dtype=bool,
        )
        self.global_mean = float(
            (self.root / "global_mean.txt").read_text(encoding="utf-8")
        )
        self.overlap_min = overlap_min
        self.shrinkage = shrinkage
        self.neighbor_count = neighbor_count
        self.surprise_mix = surprise_mix
        self.uncertainty_penalty = uncertainty_penalty
        self.candidate_shrinkage = candidate_shrinkage
        self.ancillary_penalty = ancillary_penalty
        self.residual_clip = residual_clip
        self.positive_signal_weight = positive_signal_weight
        self.negative_signal_weight = negative_signal_weight
        self.neutral_signal_weight = neutral_signal_weight
        self.absolute_preference_weight = absolute_preference_weight
        self.anchor_neighbor_quota = anchor_neighbor_quota
        self.ranking_mode = ranking_mode
        self.similarity_mode = similarity_mode
        if similarity_mode not in {"mean_centered", "residual", "surprise"}:
            raise ValueError(f"未知相似度模式: {similarity_mode}")
        if ranking_mode not in {"residual", "mean_centered"}:
            raise ValueError(f"未知候选排序模式: {ranking_mode}")

        self.user_ids = np.load(
            self.root / "user_ids.npy", mmap_mode="r"
        )
        self.mal_ids = np.load(self.root / "mal_ids.npy", mmap_mode="r")
        self.item_bias = np.load(
            self.root / "item_bias.npy", mmap_mode="r"
        )
        self.item_counts = np.load(
            self.root / "item_counts.npy", mmap_mode="r"
        )
        user_rating_mean_path = self.root / "user_rating_mean.npy"
        self.user_rating_mean = (
            np.load(user_rating_mean_path, mmap_mode="r")
            if user_rating_mean_path.exists()
            else None
        )
        self.item_iuf = np.load(
            self.root / "item_iuf.npy", mmap_mode="r"
        )
        self.item_surprise = np.load(
            self.root / "item_surprise.npy", mmap_mode="r"
        )
        calibration_path = self.root / "affinity_calibration.npz"
        if calibration_path.exists():
            calibration = np.load(calibration_path)
            self.affinity_score_knots = calibration["score_knots"]
            self.affinity_value_knots = calibration["affinity_knots"]
        else:
            self.affinity_score_knots = None
            self.affinity_value_knots = None
        self.csr_residuals = np.load(
            self.root / "csr_residuals.npy", mmap_mode="r"
        )
        self.csr_ratings = np.load(
            self.root / "csr_ratings.npy", mmap_mode="r"
        )
        self.csr_indices = np.load(
            self.root / "csr_indices.npy", mmap_mode="r"
        )
        self.csr_indptr = np.load(
            self.root / "csr_indptr.npy", mmap_mode="r"
        )
        self.csc_residuals = np.load(
            self.root / "csc_residuals.npy", mmap_mode="r"
        )
        self.csc_ratings = np.load(
            self.root / "csc_ratings.npy", mmap_mode="r"
        )
        self.csc_indices = np.load(
            self.root / "csc_indices.npy", mmap_mode="r"
        )
        self.csc_indptr = np.load(
            self.root / "csc_indptr.npy", mmap_mode="r"
        )
        self._mal_to_item = {
            int(mal_id): index for index, mal_id in enumerate(self.mal_ids)
        }
        self.item_rating_counts = {
            int(self.mal_ids[index]): int(count)
            for index, count in enumerate(self.item_counts)
            if count > 0
        }

        expected_users = self.manifest["ratings"]["users"]
        expected_items = self.manifest["ratings"]["catalog_items"]
        expected_nnz = self.manifest["ratings"]["cleaned_rows"]
        if len(self.user_ids) != expected_users:
            raise ValueError("用户索引与 manifest 不一致。")
        if len(self.mal_ids) != expected_items:
            raise ValueError("作品索引与完整作品主表不一致。")
        if len(self.csr_residuals) != expected_nnz:
            raise ValueError("评分索引与 manifest 不一致。")
        if int(self.csr_indptr[-1]) != expected_nnz:
            raise ValueError("CSR 指针不完整。")
        if int(self.csc_indptr[-1]) != expected_nnz:
            raise ValueError("CSC 指针不完整。")

    @staticmethod
    def _load_title_overrides(
        path: Path | None,
    ) -> dict[int, dict[str, str | float | None]]:
        if not path or not path.exists():
            return {}
        schema = pl.read_parquet_schema(path)
        columns = ["mal_id", "title_zh", "title_native"]
        if "score" in schema:
            columns.append("score")
        frame = (
            pl.read_parquet(
                path,
                columns=columns,
            )
            .filter(pl.col("mal_id").is_not_null())
            .unique("mal_id", keep="first")
        )
        return {
            int(row["mal_id"]): {
                "title_zh": row["title_zh"],
                "title_native": row["title_native"],
                "bangumi_score": (
                    float(row["score"])
                    if row.get("score") is not None
                    and float(row["score"]) > 0
                    else None
                ),
            }
            for row in frame.iter_rows(named=True)
        }

    def _genres_for_item(self, item_idx: int) -> list[str]:
        raw = self.catalog.row(item_idx, named=True).get("genres")
        if not raw:
            return []
        try:
            values = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            values = [part.strip() for part in str(raw).split(",")]
        tags = []
        seen = set()
        for value in values:
            normalized = re.sub(
                r"\s+",
                " ",
                str(value).strip().casefold(),
            )
            canonical = self.TAG_ALIASES.get(normalized)
            if canonical is None or canonical in seen:
                continue
            tags.append(canonical)
            seen.add(canonical)
        return tags

    def _liked_genre_weights(
        self, ratings: dict[int, float]
    ) -> Counter[str]:
        if not ratings:
            return Counter()
        threshold = max(
            7.0,
            float(np.quantile(np.asarray(list(ratings.values())), 0.75)),
        )
        weights: Counter[str] = Counter()
        for mal_id, rating in ratings.items():
            if rating < threshold:
                continue
            item_idx = self._mal_to_item.get(int(mal_id))
            if item_idx is None:
                continue
            for genre in self._genres_for_item(item_idx):
                weights[genre] += 1
        return weights

    def _matched_tags(
        self, item_idx: int, liked_genres: Counter[str]
    ) -> list[str]:
        genres = self._genres_for_item(item_idx)
        ranked = sorted(
            (genre for genre in genres if liked_genres[genre] > 0),
            key=lambda genre: (
                -self.TAG_SPECIFICITY.get(genre, 1.0)
                * (1 + min(liked_genres[genre], 5) / 5),
                genres.index(genre),
            ),
        )
        return [self.GENRE_LABELS.get(genre, genre) for genre in ranked[:3]]

    @staticmethod
    def _buckets(values: np.ndarray) -> np.ndarray:
        return np.where(values <= -0.7, 0, np.where(values >= 0.7, 2, 1))

    @staticmethod
    def _series_key(title: str | None) -> str:
        """Return a conservative franchise key used only for de-duplication.

        The source catalog does not contain a complete relation graph.  This
        normalizer therefore groups obvious seasons and bonus entries without
        pretending that every similarly named work belongs to one franchise.
        """
        normalized = unicodedata.normalize("NFKC", title or "").lower()
        normalized = re.sub(r"\([^)]*\)|\[[^]]*]", " ", normalized)
        normalized = re.sub(
            r"^(?:the\s+)?(?:movie|film|ova|ona|special)\s*[:\-]\s*",
            "",
            normalized,
        )
        if ":" in normalized:
            prefix, _ = normalized.split(":", 1)
            if len(re.findall(r"[a-z0-9]+", prefix)) >= 2:
                normalized = prefix
        tokens = re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", normalized)
        sequel_tokens = {
            "season",
            "part",
            "cour",
            "movie",
            "film",
            "ova",
            "ona",
            "special",
            "recap",
            "summary",
            "2nd",
            "3rd",
            "4th",
            "second",
            "third",
            "fourth",
        }
        tokens = [
            token
            for token in tokens
            if token not in sequel_tokens
            and not token.isdigit()
            and token not in {"ii", "iii", "iv"}
        ]
        if not tokens:
            return normalized.strip()
        if "-" in tokens[0] and tokens[0] not in {"k-on"}:
            width = 1
        elif len(tokens) >= 2 and tokens[1] == "love-ru":
            width = 2
        else:
            width = min(4, len(tokens))
        return " ".join(tokens[:width])

    @staticmethod
    def _is_ancillary(format_name: str | None, title: str | None) -> bool:
        format_value = (format_name or "").upper()
        if format_value in {
            "OVA",
            "SPECIAL",
            "TV SPECIAL",
            "MUSIC",
            "PV",
            "CM",
        }:
            return True
        title_value = (title or "").lower()
        return bool(
            re.search(
                r"\b(?:recap|summary|picture drama|promotional video)\b",
                title_value,
            )
        )

    @staticmethod
    def _looks_like_continuation(title: str | None) -> bool:
        value = unicodedata.normalize("NFKC", title or "").lower()
        return bool(
            re.search(
                r"(?:\b(?:season|part)\s*(?:[2-9]|ii|iii|iv)\b"
                r"|\b(?:2nd|3rd|4th)\b"
                r"|(?:^|[\s:])(?:ii|iii|iv)(?:$|[\s:])"
                r"|[×x]\s*(?:[2-9]|\d{3,4})\b"
                r"|\br[2-9]\b)",
                value,
            )
        )

    @classmethod
    def _requires_series_context(
        cls,
        format_name: str | None,
        title: str | None,
    ) -> bool:
        if cls._is_ancillary(format_name, title):
            return True
        if (format_name or "").upper() != "MOVIE":
            return False
        value = title or ""
        return bool(
            re.search(
                r"[:\[\]]|\b(?:movie|film|gekijouban)\b",
                value,
                flags=re.IGNORECASE,
            )
        )

    def _series_balance(self, item_indices: np.ndarray) -> np.ndarray:
        keys = [str(self.catalog_series_keys[index]) for index in item_indices]
        counts: dict[str, int] = {}
        for key in keys:
            counts[key] = counts.get(key, 0) + 1
        return np.fromiter(
            (1.0 / np.sqrt(counts[key]) for key in keys),
            dtype=np.float32,
            count=len(keys),
        )

    def _target(
        self, ratings: dict[int, float]
    ) -> tuple[np.ndarray, np.ndarray]:
        mapped = [
            (self._mal_to_item[mal_id], float(rating))
            for mal_id, rating in ratings.items()
            if mal_id in self._mal_to_item and 1 <= rating <= 10
        ]
        if not mapped:
            return (
                np.empty(0, dtype=np.int32),
                np.empty(0, dtype=np.float32),
            )
        item_indices = np.fromiter(
            (item for item, _ in mapped), dtype=np.int32
        )
        values = np.fromiter(
            (rating for _, rating in mapped), dtype=np.float32
        )
        user_bias = (
            float(values.sum()) - len(values) * self.global_mean
        ) / (len(values) + 10.0)
        raw = (
            values
            - self.global_mean
            - user_bias
            - self.item_bias[item_indices]
        )
        scale = max(float(np.std(raw)), 0.5)
        residuals = np.clip(
            raw / scale,
            -self.residual_clip,
            self.residual_clip,
        )
        return item_indices, residuals.astype(np.float32)

    def _target_signal_weight(self, value: float) -> float:
        if value >= 0.7:
            return self.positive_signal_weight
        if value <= -0.7:
            return self.negative_signal_weight
        return self.neutral_signal_weight

    def neighbors(
        self,
        ratings: dict[int, float],
        excluded_user_indices: set[int] | None = None,
    ) -> list[IndexedNeighbor]:
        target_items, target_residuals = self._target(ratings)
        if len(target_items) < self.overlap_min:
            return []
        target_values = np.fromiter(
            (
                float(ratings[int(self.mal_ids[item_idx])])
                for item_idx in target_items
            ),
            dtype=np.float32,
            count=len(target_items),
        )
        if self.similarity_mode == "mean_centered":
            if self.user_rating_mean is None:
                raise FileNotFoundError(
                    "mean-centered UserKNN 需要 user_rating_mean.npy。"
                )
            target_residuals = target_values - float(target_values.mean())
        series_balance = self._series_balance(target_items)

        user_count = len(self.user_ids)
        overlap = np.zeros(user_count, dtype=np.uint16)
        numerator = np.zeros(user_count, dtype=np.float32)
        target_norm = np.zeros(user_count, dtype=np.float32)
        neighbor_norm = np.zeros(user_count, dtype=np.float32)

        for item_idx, target_value, balance in zip(
            target_items, target_residuals, series_balance, strict=True
        ):
            start = int(self.csc_indptr[item_idx])
            stop = int(self.csc_indptr[item_idx + 1])
            users = self.csc_indices[start:stop]
            values = (
                self.csc_ratings[start:stop] - self.user_rating_mean[users]
                if self.similarity_mode == "mean_centered"
                else self.csc_residuals[start:stop]
            )
            values = np.clip(
                values,
                -self.residual_clip,
                self.residual_clip,
            )
            if not len(users):
                continue
            if self.similarity_mode == "surprise":
                target_bucket = 0 if target_value <= -0.7 else (
                    2 if target_value >= 0.7 else 1
                )
                neighbor_buckets = self._buckets(values)
                event_surprise = (
                    self.item_surprise[item_idx, target_bucket]
                    + self.item_surprise[item_idx, neighbor_buckets]
                ) * 0.5
                weights = (
                    1.0
                    + (1.0 - self.surprise_mix) * self.item_iuf[item_idx]
                    + self.surprise_mix * event_surprise
                ).astype(np.float32)
            else:
                weights = np.ones(len(users), dtype=np.float32)
            weights *= balance * self._target_signal_weight(
                float(target_value)
            )
            overlap[users] += 1
            numerator[users] += weights * target_value * values
            target_norm[users] += weights * target_value * target_value
            neighbor_norm[users] += weights * values * values

        eligible = (
            (overlap >= self.overlap_min)
            & (target_norm > 0)
            & (neighbor_norm > 0)
        )
        if excluded_user_indices:
            excluded_array = np.fromiter(
                excluded_user_indices, dtype=np.int64
            )
            excluded_array = excluded_array[
                (excluded_array >= 0) & (excluded_array < user_count)
            ]
            eligible[excluded_array] = False
        eligible_indices = np.flatnonzero(eligible)
        if not len(eligible_indices):
            return []
        similarities = numerator[eligible_indices] / np.sqrt(
            target_norm[eligible_indices] * neighbor_norm[eligible_indices]
        )
        similarities *= overlap[eligible_indices] / (
            overlap[eligible_indices] + self.shrinkage
        )
        positive = similarities > 0
        eligible_indices = eligible_indices[positive]
        similarities = similarities[positive]
        if not len(eligible_indices):
            return []

        count = min(self.neighbor_count, len(eligible_indices))
        similarity_by_user = np.full(user_count, -np.inf, dtype=np.float32)
        similarity_by_user[eligible_indices] = similarities
        selected_users: list[int] = []
        selected_set: set[int] = set()
        anchor_order = np.argsort(
            target_residuals
            * (1.0 + self.item_iuf[target_items])
            * series_balance
        )[::-1]
        for target_position in (
            anchor_order if self.anchor_neighbor_quota > 0 else []
        ):
            if target_residuals[target_position] < 0.7:
                break
            item_idx = int(target_items[target_position])
            start = int(self.csc_indptr[item_idx])
            stop = int(self.csc_indptr[item_idx + 1])
            users = self.csc_indices[start:stop]
            values = np.clip(
                self.csc_residuals[start:stop],
                -self.residual_clip,
                self.residual_clip,
            )
            anchor_users = users[
                (values >= 0.3)
                & np.isfinite(similarity_by_user[users])
            ]
            if not len(anchor_users):
                continue
            anchor_users = anchor_users[
                np.argsort(similarity_by_user[anchor_users])[::-1]
            ]
            added = 0
            for user_idx in anchor_users:
                user = int(user_idx)
                if user in selected_set:
                    continue
                selected_users.append(user)
                selected_set.add(user)
                added += 1
                if (
                    added >= self.anchor_neighbor_quota
                    or len(selected_users) >= count
                ):
                    break
            if len(selected_users) >= count:
                break
        if len(selected_users) < count:
            global_order = eligible_indices[
                np.argsort(similarities)[::-1]
            ]
            for user_idx in global_order:
                user = int(user_idx)
                if user in selected_set:
                    continue
                selected_users.append(user)
                selected_set.add(user)
                if len(selected_users) >= count:
                    break
        eligible_indices = np.asarray(selected_users, dtype=np.int64)
        similarities = similarity_by_user[eligible_indices]
        order = np.argsort(similarities)[::-1]
        return [
            IndexedNeighbor(
                user_idx=int(eligible_indices[index]),
                similarity=float(similarities[index]),
                overlap=int(overlap[eligible_indices[index]]),
            )
            for index in order
        ]

    def _catalog_item(self, item_idx: int) -> dict:
        row = self.catalog.row(item_idx, named=True)
        override = self.title_overrides.get(int(row["mal_id"]), {})
        return {
            "mal_id": int(row["mal_id"]),
            "title_zh": override.get("title_zh") or row["title"],
            "title_native": (
                override.get("title_native")
                or row["alternative_title"]
                or row["title"]
            ),
            "title_en": row["title"],
            "format": row["format"],
            "year": row["year"],
            "episodes": row["episodes"],
            "cover_url": row["image_url"],
            "cover_index": item_idx % 8,
            "release_status": row.get("release_status") or "未知",
            "synopsis": row.get("synopsis") or "",
            "is_adult": bool(
                row.get("is_adult")
                or "Hentai" in (row["genres"] or "")
            ),
            "platform_mean": row["source_score"],
            "bangumi_score": override.get("bangumi_score"),
            "matched_tags": [],
        }

    def recommend(
        self,
        ratings: dict[int, float],
        excluded: set[int] | None = None,
        limit: int = 20,
        min_support: int = 5,
        minimum_item_ratings: int = 20,
        excluded_user_indices: set[int] | None = None,
        allow_sequels: bool = True,
        formats: list[str] | None = None,
    ) -> list[dict]:
        target_items, target_residuals = self._target(ratings)
        neighbors = self.neighbors(
            ratings, excluded_user_indices=excluded_user_indices
        )
        if not neighbors:
            return []
        liked_genres = self._liked_genre_weights(ratings)
        item_count = len(self.mal_ids)
        weighted_sum = np.zeros(item_count, dtype=np.float64)
        weight_sum = np.zeros(item_count, dtype=np.float64)
        weighted_square_sum = np.zeros(item_count, dtype=np.float64)
        squared_weight_sum = np.zeros(item_count, dtype=np.float64)
        weighted_raw_rating_sum = np.zeros(item_count, dtype=np.float64)
        support = np.zeros(item_count, dtype=np.int32)
        distribution = np.zeros((4, item_count), dtype=np.int16)
        neighbor_target_values = np.full(
            (len(neighbors), len(target_items)),
            np.nan,
            dtype=np.float32,
        )
        target_positions = {
            int(item_idx): position
            for position, item_idx in enumerate(target_items)
        }

        for neighbor_position, neighbor in enumerate(neighbors):
            start = int(self.csr_indptr[neighbor.user_idx])
            stop = int(self.csr_indptr[neighbor.user_idx + 1])
            items = self.csr_indices[start:stop]
            values = (
                self.csr_residuals[start:stop]
                if self.ranking_mode == "residual"
                else self.csr_ratings[start:stop]
                - self.user_rating_mean[neighbor.user_idx]
            )
            values = np.clip(
                values,
                -self.residual_clip,
                self.residual_clip,
            )
            similarity = neighbor.similarity
            weighted_sum[items] += similarity * values
            weight_sum[items] += similarity
            weighted_square_sum[items] += similarity * values * values
            squared_weight_sum[items] += similarity * similarity
            support[items] += 1
            raw_ratings = self.csr_ratings[start:stop]
            weighted_raw_rating_sum[items] += similarity * raw_ratings
            distribution[0, items[raw_ratings <= 4]] += 1
            distribution[
                1, items[(raw_ratings >= 5) & (raw_ratings <= 6)]
            ] += 1
            distribution[
                2, items[(raw_ratings >= 7) & (raw_ratings <= 8)]
            ] += 1
            distribution[3, items[raw_ratings >= 9]] += 1
            for row_position, item_idx in enumerate(items):
                target_position = target_positions.get(int(item_idx))
                if target_position is not None:
                    neighbor_target_values[
                        neighbor_position, target_position
                    ] = values[row_position]

        excluded_mal_ids = set(excluded or set()).union(ratings)
        excluded_items = [
            self._mal_to_item[mal_id]
            for mal_id in excluded_mal_ids
            if mal_id in self._mal_to_item
        ]
        eligible = (
            (support >= min_support)
            & (weight_sum > 0)
            & (self.item_counts >= minimum_item_ratings)
        )
        if formats:
            normalized_formats = {value.upper() for value in formats}
            eligible &= np.isin(self.catalog_formats, list(normalized_formats))
        if not allow_sequels:
            eligible &= ~(
                self.catalog_sequels
                | self.catalog_inferred_continuations
            )
            profile_series = {
                str(self.catalog_series_keys[item_idx])
                for item_idx in target_items
            }
            missing_series_context = (
                self.catalog_requires_series_context
                & ~np.isin(
                    self.catalog_series_keys,
                    list(profile_series),
                )
            )
            eligible &= ~missing_series_context
        if excluded_items:
            eligible[np.asarray(excluded_items, dtype=np.int32)] = False

        estimate = np.zeros(item_count, dtype=np.float64)
        estimate[eligible] = weighted_sum[eligible] / weight_sum[eligible]
        variance = np.zeros(item_count, dtype=np.float64)
        variance[eligible] = np.maximum(
            weighted_square_sum[eligible] / weight_sum[eligible]
            - estimate[eligible] ** 2,
            0,
        )
        effective_sample = np.zeros(item_count, dtype=np.float64)
        effective_sample[eligible] = (
            weight_sum[eligible] ** 2
            / np.maximum(squared_weight_sum[eligible], 1e-12)
        )
        eligible &= effective_sample >= 3
        rank_score = np.full(item_count, -np.inf, dtype=np.float64)
        reliability = np.zeros(item_count, dtype=np.float64)
        reliability[eligible] = effective_sample[eligible] / (
            effective_sample[eligible] + self.candidate_shrinkage
        )
        neighbor_mean_rating = np.zeros(item_count, dtype=np.float64)
        neighbor_mean_rating[eligible] = (
            weighted_raw_rating_sum[eligible] / weight_sum[eligible]
        )
        absolute_preference = np.clip(
            (neighbor_mean_rating - 7.5) / 2.5,
            -1.0,
            1.0,
        )
        rank_score[eligible] = estimate[eligible] * reliability[eligible] - (
            self.uncertainty_penalty
            * np.sqrt(
                variance[eligible] / effective_sample[eligible]
            )
        ) + self.absolute_preference_weight * absolute_preference[eligible]
        rank_score[self.catalog_ancillary & eligible] -= (
            self.ancillary_penalty
        )
        candidates = np.flatnonzero(eligible)
        if not len(candidates):
            return []
        candidates = candidates[
            np.argsort(rank_score[candidates])[::-1]
        ]
        diverse_candidates: list[int] = []
        used_series: set[str] = set()
        for item_idx in candidates:
            series_key = str(self.catalog_series_keys[item_idx])
            if series_key and series_key in used_series:
                continue
            diverse_candidates.append(int(item_idx))
            if series_key:
                used_series.add(series_key)
            if len(diverse_candidates) >= limit:
                break
        candidates = np.asarray(diverse_candidates, dtype=np.int32)

        output = []
        for item_idx in candidates:
            supporting_neighbors = np.zeros(len(neighbors), dtype=bool)
            for neighbor_position, neighbor in enumerate(neighbors):
                start = int(self.csr_indptr[neighbor.user_idx])
                stop = int(self.csr_indptr[neighbor.user_idx + 1])
                row_items = self.csr_indices[start:stop]
                item_position = int(np.searchsorted(row_items, item_idx))
                supporting_neighbors[neighbor_position] = (
                    item_position < len(row_items)
                    and int(row_items[item_position]) == int(item_idx)
                )
            evidence = self._candidate_evidence(
                ratings=ratings,
                target_items=target_items,
                target_residuals=target_residuals,
                neighbors=neighbors,
                neighbor_target_values=neighbor_target_values,
                supporting_neighbors=supporting_neighbors,
            )
            affinity = int(
                np.clip(
                    round(50 + 32 * np.tanh(rank_score[item_idx])),
                    1,
                    95,
                )
            )
            sample = effective_sample[item_idx]
            item_support = int(support[item_idx])
            confidence = (
                "高"
                if (
                    item_support >= 20
                    and sample >= 12
                    and variance[item_idx] <= 0.8
                    and not self.catalog_ancillary[item_idx]
                )
                else "中"
                if item_support >= 8 and sample >= 5
                else "低"
            )
            evidence_title = evidence[0]["title"] if evidence else None
            anime = self._catalog_item(int(item_idx))
            anime["matched_tags"] = self._matched_tags(
                int(item_idx), liked_genres
            )
            output.append(
                {
                    "anime": anime,
                    "rank_score": round(float(rank_score[item_idx]), 6),
                    "affinity": affinity,
                    "confidence": confidence,
                    "support": item_support,
                    "effective_sample_size": round(float(sample), 2),
                    "neighbor_variance": round(float(variance[item_idx]), 6),
                    "reason": (
                        f"{item_support} 名相似用户支持，"
                        f"其中与《{evidence_title}》的评价最能说明本次匹配。"
                        if evidence_title
                        else f"{item_support} 名相似用户支持本次推荐。"
                    ),
                    "evidence": evidence,
                    "neighbor_distribution": {
                        "1-4": int(distribution[0, item_idx]),
                        "5-6": int(distribution[1, item_idx]),
                        "7-8": int(distribution[2, item_idx]),
                        "9-10": int(distribution[3, item_idx]),
                    },
                    "risk": (
                        "属于系列附属内容，已降低排序权重。"
                        if self.catalog_ancillary[item_idx]
                        else "相似用户意见分歧较大，亲和度可能波动。"
                        if variance[item_idx] > 0.8
                        else "支持样本较少，当前排序已进行收缩校正。"
                        if item_support < 10
                        else "样本意见较集中，仍需结合观看时长判断。"
                    ),
                    "relation_notice": (
                        "该作品被标记为续作，请确认已完成前作。"
                        if self.catalog_sequels[item_idx]
                        else None
                    ),
                }
            )
        return output

    def _candidate_evidence(
        self,
        ratings: dict[int, float],
        target_items: np.ndarray,
        target_residuals: np.ndarray,
        neighbors: list[IndexedNeighbor],
        neighbor_target_values: np.ndarray,
        supporting_neighbors: np.ndarray,
    ) -> list[dict]:
        if not supporting_neighbors.any():
            return []
        similarities = np.asarray(
            [neighbor.similarity for neighbor in neighbors],
            dtype=np.float32,
        )[supporting_neighbors]
        values = neighbor_target_values[supporting_neighbors]
        series_balance = self._series_balance(target_items)
        contributions = np.zeros(len(target_items), dtype=np.float64)
        neighbor_means = np.zeros(len(target_items), dtype=np.float64)
        for position, (item_idx, target_value, balance) in enumerate(
            zip(
                target_items,
                target_residuals,
                series_balance,
                strict=True,
            )
        ):
            column = values[:, position]
            present = ~np.isnan(column)
            if not present.any():
                continue
            item_similarities = similarities[present]
            neighbor_values = column[present]
            neighbor_mean = float(
                np.sum(item_similarities * neighbor_values)
                / np.sum(item_similarities)
            )
            neighbor_means[position] = neighbor_mean
            target_bucket = (
                0 if target_value <= -0.7 else 2 if target_value >= 0.7 else 1
            )
            neighbor_buckets = self._buckets(neighbor_values)
            event_surprise = (
                self.item_surprise[item_idx, target_bucket]
                + self.item_surprise[item_idx, neighbor_buckets]
            ) * 0.5
            event_weights = (
                1.0
                + (1.0 - self.surprise_mix) * self.item_iuf[item_idx]
                + self.surprise_mix * event_surprise
            )
            contributions[position] = float(
                balance
                * self._target_signal_weight(float(target_value))
                * np.sum(
                    item_similarities
                    * event_weights
                    * target_value
                    * neighbor_values
                )
            )
        positive = np.flatnonzero(contributions > 0)
        if not len(positive):
            positive = np.flatnonzero(contributions != 0)
        if not len(positive):
            return []
        order = positive[
            np.argsort(np.abs(contributions[positive]))[::-1]
        ][:3]
        normalizer = max(float(np.abs(contributions[order]).sum()), 1e-12)
        evidence = []
        for position in order:
            item_idx = int(target_items[position])
            row = self.catalog.row(item_idx, named=True)
            override = self.title_overrides.get(int(row["mal_id"]), {})
            target_value = float(target_residuals[position])
            neighbor_value = float(neighbor_means[position])
            evidence.append(
                {
                    "mal_id": int(self.mal_ids[item_idx]),
                    "title": override.get("title_zh") or row["title"],
                    "your_rating": float(
                        ratings[int(self.mal_ids[item_idx])]
                    ),
                    "signal": (
                        "共同喜欢低关注作品"
                        if target_value >= 0.7 and neighbor_value >= 0.3
                        else "共同低评大众作品"
                        if target_value <= -0.7 and neighbor_value <= -0.3
                        else "整体评价走势接近"
                    ),
                    "contribution": round(
                        float(abs(contributions[position]) / normalizer),
                        4,
                    ),
                }
            )
        return evidence
