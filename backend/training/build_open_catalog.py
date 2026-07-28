from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np
import polars as pl
import zstandard as zstd


MAL_SOURCE = re.compile(
    r"https?://myanimelist\.net/anime/(?P<mal_id>\d+)(?:/.*)?"
)
REPLACED_FILES = {
    "anime_ids.npy",
    "bangumi-mapping.parquet",
    "catalog.parquet",
    "csc_indptr.npy",
    "item_bias.npy",
    "item_counts.npy",
    "item_iuf.npy",
    "item_rating_mean.npy",
    "item_surprise.npy",
    "mal_ids.npy",
    "manifest.json",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _link_or_copy(source: Path, target: Path) -> None:
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _mal_ids(record: dict) -> list[int]:
    result: list[int] = []
    for source in record.get("sources") or []:
        match = MAL_SOURCE.fullmatch(str(source))
        if match:
            result.append(int(match.group("mal_id")))
    return result


def _year(value: object) -> int | None:
    text = str(value or "")
    return int(text[:4]) if len(text) >= 4 and text[:4].isdigit() else None


def _translation(item: dict, language: str) -> str | None:
    values = (item.get("titleTranslate") or {}).get(language) or []
    for value in values:
        text = str(value).strip()
        if text:
            return text
    return None


def _site_ids(item: dict) -> dict[str, str]:
    result: dict[str, str] = {}
    for site in item.get("sites") or []:
        name = site.get("site")
        identifier = site.get("id")
        if name and identifier:
            result[str(name)] = str(identifier)
    return result


def _load_anime_offline(path: Path) -> tuple[dict[int, dict], dict]:
    with path.open("rb") as compressed:
        with zstd.ZstdDecompressor().stream_reader(compressed) as reader:
            payload = json.load(reader)
    records: dict[int, dict] = {}
    for record in payload.get("data") or []:
        for mal_id in _mal_ids(record):
            if mal_id in records:
                raise ValueError(
                    f"anime-offline-database 出现重复 MAL ID: {mal_id}"
                )
            records[mal_id] = record
    return records, payload


def _load_bangumi_data(
    path: Path,
) -> tuple[list[dict], dict[int, dict]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    mapping_rows: list[dict] = []
    preferred_by_mal: dict[int, dict] = {}
    seen_subjects: set[int] = set()
    for item in payload.get("items") or []:
        sites = _site_ids(item)
        if "mal" not in sites or "bangumi" not in sites:
            continue
        try:
            mal_id = int(sites["mal"])
            subject_id = int(sites["bangumi"])
        except ValueError:
            continue
        title_native = str(item.get("title") or "").strip() or None
        title_zh = _translation(item, "zh-Hans")
        row = {
            "bangumi_subject_id": subject_id,
            "mal_id": mal_id,
            "match_method": "bangumi_data_direct_ids",
            "title_native": title_native,
            "title_zh": title_zh,
            "year": _year(item.get("begin")),
        }
        if subject_id not in seen_subjects:
            mapping_rows.append(row)
            seen_subjects.add(subject_id)
        previous = preferred_by_mal.get(mal_id)
        if previous is None or (
            not previous.get("title_zh") and title_zh
        ):
            preferred_by_mal[mal_id] = row
    return mapping_rows, preferred_by_mal


def _open_record(
    record: dict,
    *,
    anime_id: int,
    mal_id: int,
    sequel: bool,
    bangumi: dict | None,
    source_version: str,
) -> dict:
    tags = [str(tag) for tag in record.get("tags") or [] if tag]
    score = record.get("score") or {}
    season = record.get("animeSeason") or {}
    title_native = (bangumi or {}).get("title_native")
    synonyms = [
        str(value).strip()
        for value in record.get("synonyms") or []
        if str(value).strip()
    ]
    if not title_native:
        title_native = next(
            (
                value
                for value in synonyms
                if any(ord(character) > 127 for character in value)
            ),
            None,
        )
    return {
        "anime_id": anime_id,
        "mal_id": mal_id,
        "title": str(record.get("title") or f"MAL #{mal_id}"),
        "alternative_title": title_native,
        "format": str(record.get("type") or "UNKNOWN").upper(),
        "year": season.get("year"),
        "episodes": record.get("episodes"),
        "source_score": score.get("arithmeticMean"),
        "mal_url": f"https://myanimelist.net/anime/{mal_id}",
        "image_url": record.get("picture") or record.get("thumbnail"),
        "sequel": sequel,
        "genres": json.dumps(tags, ensure_ascii=False),
        "genres_detailed": "",
        "release_status": record.get("status"),
        "synopsis": None,
        "is_adult": any(tag.casefold() == "hentai" for tag in tags),
        "catalog_source": (
            f"anime-offline-database-{source_version}"
        ),
    }


def _preserved_record(row: dict) -> dict:
    mal_id = int(row["mal_id"])
    return {
        "anime_id": int(row["anime_id"]),
        "mal_id": mal_id,
        "title": row.get("title") or f"MAL #{mal_id}",
        "alternative_title": row.get("alternative_title"),
        "format": row.get("format") or "UNKNOWN",
        "year": row.get("year"),
        "episodes": row.get("episodes"),
        "source_score": None,
        "mal_url": f"https://myanimelist.net/anime/{mal_id}",
        "image_url": None,
        "sequel": bool(row.get("sequel")),
        "genres": "[]",
        "genres_detailed": "",
        "release_status": row.get("release_status") or "UNKNOWN",
        "synopsis": None,
        "is_adult": False,
        "catalog_source": "ratings-index-id-preserved",
    }


def build_open_catalog(
    source_artifact: Path,
    anime_offline_path: Path,
    bangumi_data_path: Path,
    output: Path,
) -> dict:
    if output.exists():
        raise FileExistsError(f"输出目录已存在，拒绝覆盖: {output}")
    output.mkdir(parents=True)
    try:
        old_manifest = json.loads(
            (source_artifact / "manifest.json").read_text(encoding="utf-8")
        )
        old_catalog = pl.read_parquet(
            source_artifact / "catalog.parquet"
        ).sort("anime_id")
        open_records, open_payload = _load_anime_offline(
            anime_offline_path
        )
        mapping_rows, bangumi_by_mal = _load_bangumi_data(
            bangumi_data_path
        )
        source_version = str(
            open_payload.get("lastUpdate") or "unknown"
        ).split("T", 1)[0]

        records: list[dict] = []
        old_rows = list(old_catalog.iter_rows(named=True))
        old_ids = {int(row["mal_id"]) for row in old_rows}
        missing_ids: list[int] = []
        for row in old_rows:
            mal_id = int(row["mal_id"])
            open_record = open_records.get(mal_id)
            if open_record:
                records.append(
                    _open_record(
                        open_record,
                        anime_id=int(row["anime_id"]),
                        mal_id=mal_id,
                        sequel=bool(row["sequel"]),
                        bangumi=bangumi_by_mal.get(mal_id),
                        source_version=source_version,
                    )
                )
            else:
                missing_ids.append(mal_id)
                records.append(_preserved_record(row))

        next_anime_id = max(int(row["anime_id"]) for row in old_rows) + 1
        added_ids = sorted(set(open_records).difference(old_ids))
        for offset, mal_id in enumerate(added_ids):
            records.append(
                _open_record(
                    open_records[mal_id],
                    anime_id=next_anime_id + offset,
                    mal_id=mal_id,
                    sequel=False,
                    bangumi=bangumi_by_mal.get(mal_id),
                    source_version=source_version,
                )
            )

        catalog = (
            pl.DataFrame(records)
            .with_columns(
                pl.col("anime_id").cast(pl.Int32),
                pl.col("mal_id").cast(pl.Int32),
                pl.col("year").cast(pl.Int32, strict=False),
                pl.col("episodes").cast(pl.Int32, strict=False),
                pl.col("source_score").cast(pl.Float32, strict=False),
                pl.col("sequel").cast(pl.Boolean),
                pl.col("is_adult").cast(pl.Boolean),
            )
            .sort("anime_id")
        )
        if (
            catalog["mal_id"].null_count()
            or catalog["mal_id"].n_unique() != catalog.height
            or catalog["anime_id"].n_unique() != catalog.height
        ):
            raise ValueError("开放目录未通过 ID 完整性检查。")
        observed_old_ids = catalog.head(old_catalog.height)["mal_id"].to_list()
        expected_old_ids = old_catalog["mal_id"].to_list()
        if observed_old_ids != expected_old_ids:
            raise ValueError("原模型 MAL ID 顺序发生变化。")

        anime_id_by_mal = dict(
            catalog.select("mal_id", "anime_id").iter_rows()
        )
        mapping = (
            pl.DataFrame(mapping_rows)
            .with_columns(
                pl.col("bangumi_subject_id").cast(pl.Int64),
                pl.col("mal_id").cast(pl.Int64),
                pl.col("year").cast(pl.Int32, strict=False),
                pl.col("mal_id")
                .replace_strict(
                    anime_id_by_mal,
                    default=None,
                    return_dtype=pl.Int32,
                )
                .alias("anime_id"),
            )
            .filter(pl.col("anime_id").is_not_null())
            .select(
                "bangumi_subject_id",
                "mal_id",
                "anime_id",
                "match_method",
                "title_native",
                "title_zh",
                "year",
            )
            .sort("bangumi_subject_id")
        )
        if (
            mapping["bangumi_subject_id"].null_count()
            or mapping["bangumi_subject_id"].n_unique()
            != mapping.height
        ):
            raise ValueError("Bangumi subject ID 映射不唯一。")

        for source in source_artifact.iterdir():
            if source.is_file() and source.name not in REPLACED_FILES:
                _link_or_copy(source, output / source.name)

        catalog.write_parquet(
            output / "catalog.parquet",
            compression="zstd",
            statistics=True,
        )
        mapping.write_parquet(
            output / "bangumi-mapping.parquet",
            compression="zstd",
            statistics=True,
        )

        old_count = old_catalog.height
        new_count = catalog.height
        old_nnz = int(old_manifest["ratings"]["cleaned_rows"])
        np.save(
            output / "anime_ids.npy",
            catalog["anime_id"].to_numpy().astype(np.int32),
        )
        np.save(
            output / "mal_ids.npy",
            catalog["mal_id"].to_numpy().astype(np.int32),
        )
        for name, dtype, fill in (
            ("item_bias.npy", np.float32, 0.0),
            ("item_counts.npy", np.int64, 0),
            ("item_rating_mean.npy", np.float32, 0.0),
        ):
            old_values = np.load(source_artifact / name, mmap_mode="r")
            values = np.full(new_count, fill, dtype=dtype)
            values[:old_count] = old_values
            np.save(output / name, values)

        old_iuf = np.load(
            source_artifact / "item_iuf.npy", mmap_mode="r"
        )
        iuf = np.full(
            new_count,
            math.log((old_manifest["ratings"]["users"] + 1) / 1),
            dtype=np.float32,
        )
        iuf[:old_count] = old_iuf
        np.save(output / "item_iuf.npy", iuf)

        old_surprise = np.load(
            source_artifact / "item_surprise.npy", mmap_mode="r"
        )
        surprise = np.full(
            (new_count, 3),
            -math.log(1 / 3),
            dtype=np.float32,
        )
        surprise[:old_count] = old_surprise
        np.save(output / "item_surprise.npy", surprise)

        old_indptr = np.load(
            source_artifact / "csc_indptr.npy", mmap_mode="r"
        )
        indptr = np.full(new_count + 1, old_nnz, dtype=np.int64)
        indptr[: old_count + 1] = old_indptr
        np.save(output / "csc_indptr.npy", indptr)

        manifest = dict(old_manifest)
        manifest["created_at"] = datetime.now(UTC).isoformat()
        manifest["data_version"] = (
            f"user-animelist-v1+anime-offline-{source_version}"
            "+bangumi-data-0.3.216"
        )
        manifest["parent_artifact"] = str(source_artifact.resolve())
        manifest["catalog"] = {
            "rows": new_count,
            "unique_anime_ids": catalog["anime_id"].n_unique(),
            "unique_mal_ids": catalog["mal_id"].n_unique(),
            "training_catalog_rows": old_count,
            "anime_offline_mal_rows": len(open_records),
            "added_open_rows": new_count - old_count,
            "preserved_rating_ids_absent_from_open_source": len(
                missing_ids
            ),
            "bangumi_direct_id_mappings": mapping.height,
            "old_mal_id_order_preserved": True,
        }
        manifest["ratings"] = {
            **old_manifest["ratings"],
            "catalog_items": new_count,
        }
        manifest["redistributable_sources"] = [
            {
                "name": "User Animelist Dataset",
                "license": "CC-BY-4.0",
                "url": (
                    "https://www.kaggle.com/datasets/ramazanturann/"
                    "user-animelist-dataset"
                ),
            },
            {
                "name": "anime-offline-database",
                "version": source_version,
                "license": "ODbL-1.0 + DbCL-1.0",
                "url": str(open_payload.get("repository") or ""),
                "sha256": _sha256(anime_offline_path),
            },
            {
                "name": "bangumi-data",
                "version": "0.3.216",
                "license": "CC-BY-4.0",
                "url": "https://www.npmjs.com/package/bangumi-data",
                "sha256": _sha256(
                    bangumi_data_path.parents[2]
                    / "bangumi-data-0.3.216.tgz"
                ),
            },
        ]
        (output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return manifest
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "用开放许可目录替换模型元数据，同时保持原评分索引顺序。"
        )
    )
    result.add_argument("source_artifact", type=Path)
    result.add_argument("anime_offline_zst", type=Path)
    result.add_argument("bangumi_data_json", type=Path)
    result.add_argument("--output", required=True, type=Path)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = build_open_catalog(
        args.source_artifact,
        args.anime_offline_zst,
        args.bangumi_data_json,
        args.output,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
