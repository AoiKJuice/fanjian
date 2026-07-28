from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import polars as pl


def _normalize_title(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").casefold()
    return re.sub(r"[^\w]+", "", normalized)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _year(value: object) -> int | None:
    text = str(value or "")
    return int(text[:4]) if len(text) >= 4 and text[:4].isdigit() else None


def build_mapping(
    subject_directory: Path,
    catalog_path: Path,
    bangumi_data_path: Path | None,
    output: Path,
    manifest_output: Path,
    source_url: str,
    source_revision: str,
) -> dict:
    catalog = pl.read_parquet(catalog_path).select(
        "anime_id",
        "mal_id",
        "title",
        "alternative_title",
        "year",
    )
    title_index: dict[str, dict[int, dict]] = defaultdict(dict)
    for record in catalog.iter_rows(named=True):
        for title in (record["title"], record["alternative_title"]):
            normalized = _normalize_title(title)
            if normalized:
                title_index[normalized][record["mal_id"]] = record
    catalog_by_mal = {
        int(record["mal_id"]): record
        for record in catalog.iter_rows(named=True)
    }

    direct_index: dict[int, dict] = {}
    if bangumi_data_path is not None:
        bangumi_data = json.loads(
            bangumi_data_path.read_text(encoding="utf-8")
        )
        for item in bangumi_data.get("items", []):
            sites = {
                site.get("site"): site
                for site in item.get("sites", [])
                if site.get("id")
            }
            if "bangumi" not in sites or "mal" not in sites:
                continue
            subject_id = int(sites["bangumi"]["id"])
            direct_index[subject_id] = {
                "mal_id": int(sites["mal"]["id"]),
                "gamer_id": (
                    int(sites["gamer"]["id"])
                    if sites.get("gamer")
                    else None
                ),
                "title_native": item.get("title"),
                "year": _year(item.get("begin")),
            }

    rows: list[dict] = []
    invalid_json_files = 0
    non_anime_files = 0
    for path in sorted(subject_directory.rglob("*.json")):
        try:
            subject = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            invalid_json_files += 1
            continue
        if subject.get("type") != 2:
            non_anime_files += 1
            continue

        subject_id = int(subject["id"])
        direct = direct_index.get(subject_id)
        normalized = _normalize_title(subject.get("name"))
        candidates = list(title_index.get(normalized, {}).values())
        subject_year = _year(subject.get("date"))
        same_year = [
            candidate
            for candidate in candidates
            if subject_year is not None and candidate["year"] == subject_year
        ]
        selected = None
        method = None
        if (
            direct is not None
            and direct["mal_id"] in catalog_by_mal
        ):
            selected = catalog_by_mal[direct["mal_id"]]
            method = "bangumi_data_direct_ids"
        elif len(same_year) == 1:
            selected = same_year[0]
            method = "exact_native_title_and_year"
        elif len(candidates) == 1:
            selected = candidates[0]
            method = "unique_exact_native_title"

        rating = subject.get("rating") or {}
        counts = rating.get("count") or {}
        row = {
            "bangumi_subject_id": subject_id,
            "mal_id": (
                int(selected["mal_id"]) if selected is not None else None
            ),
            "anime_id": (
                int(selected["anime_id"]) if selected is not None else None
            ),
            "match_method": method,
            "candidate_count": len(candidates),
            "gamer_id": direct.get("gamer_id") if direct else None,
            "title_native": subject.get("name"),
            "title_zh": subject.get("name_cn"),
            "year": subject_year,
            "score": float(rating.get("score") or 0),
            "vote_total": int(rating.get("total") or 0),
        }
        for score in range(1, 11):
            row[f"score_{score}_count"] = int(
                counts.get(str(score), 0) or 0
            )
        rows.append(row)

    known_subjects = {row["bangumi_subject_id"] for row in rows}
    for subject_id, direct in direct_index.items():
        if subject_id in known_subjects:
            continue
        selected = catalog_by_mal.get(direct["mal_id"])
        row = {
            "bangumi_subject_id": subject_id,
            "mal_id": int(selected["mal_id"]) if selected else None,
            "anime_id": int(selected["anime_id"]) if selected else None,
            "match_method": (
                "bangumi_data_direct_ids" if selected else None
            ),
            "candidate_count": 0,
            "gamer_id": direct["gamer_id"],
            "title_native": direct["title_native"],
            "title_zh": None,
            "year": direct["year"],
            "score": 0.0,
            "vote_total": 0,
        }
        for score in range(1, 11):
            row[f"score_{score}_count"] = 0
        rows.append(row)

    frame = pl.DataFrame(rows).sort("bangumi_subject_id")
    duplicate_subject_ids = (
        frame.group_by("bangumi_subject_id")
        .len()
        .filter(pl.col("len") > 1)
        .height
    )
    duplicate_mal_ids = (
        frame.filter(pl.col("mal_id").is_not_null())
        .group_by("mal_id")
        .len()
        .filter(pl.col("len") > 1)
        .height
    )
    if duplicate_subject_ids:
        raise ValueError("Bangumi subject ID 存在重复，拒绝写入映射。")
    if duplicate_mal_ids:
        duplicated = (
            frame.filter(pl.col("mal_id").is_not_null())
            .group_by("mal_id")
            .len()
            .filter(pl.col("len") > 1)
            .select("mal_id")
        )
        frame = frame.join(
            duplicated.with_columns(pl.lit(True).alias("_duplicate")),
            on="mal_id",
            how="left",
        ).with_columns(
            pl.when(pl.col("_duplicate").fill_null(False))
            .then(None)
            .otherwise(pl.col("mal_id"))
            .alias("mal_id"),
            pl.when(pl.col("_duplicate").fill_null(False))
            .then(None)
            .otherwise(pl.col("anime_id"))
            .alias("anime_id"),
            pl.when(pl.col("_duplicate").fill_null(False))
            .then(pl.lit("rejected_duplicate_mal_mapping"))
            .otherwise(pl.col("match_method"))
            .alias("match_method"),
        ).drop("_duplicate")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    frame.write_parquet(
        temporary_output, compression="zstd", statistics=True
    )
    temporary_output.replace(output)

    matched = frame.filter(pl.col("mal_id").is_not_null())
    total_votes = int(frame["vote_total"].sum())
    mapped_votes = int(matched["vote_total"].sum())
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "purpose": (
            "Bangumi 作品 ID 到 MAL ID 的高置信映射，以及作品级评分"
            "分布审计；作品均分不进入协同过滤排序。"
        ),
        "source": {
            "url": source_url,
            "revision": source_revision,
            "license": "MIT (mapping snapshot repository)",
            "bangumi15m_license": (
                "Unknown on Kaggle; raw anonymous user data is not included."
            ),
            "bangumi_data": (
                {
                    "url": "https://github.com/bangumi-data/bangumi-data",
                    "cdn": "https://unpkg.com/bangumi-data@0.3/dist/data.json",
                    "license": "MIT",
                }
                if bangumi_data_path is not None
                else None
            ),
        },
        "inputs": {
            "subject_directory": str(subject_directory.resolve()),
            "catalog": {
                "path": str(catalog_path.resolve()),
                "bytes": catalog_path.stat().st_size,
                "sha256": _sha256(catalog_path),
            },
            "bangumi_data": (
                {
                    "path": str(bangumi_data_path.resolve()),
                    "bytes": bangumi_data_path.stat().st_size,
                    "sha256": _sha256(bangumi_data_path),
                }
                if bangumi_data_path is not None
                else None
            ),
        },
        "statistics": {
            "subject_files": len(list(subject_directory.rglob("*.json"))),
            "anime_subjects": frame.height,
            "invalid_json_files": invalid_json_files,
            "non_anime_files": non_anime_files,
            "mapped_subjects": matched.height,
            "unmapped_subjects": frame.height - matched.height,
            "mapping_rate": matched.height / frame.height if frame.height else 0,
            "aggregate_votes": total_votes,
            "mapped_aggregate_votes": mapped_votes,
            "mapped_vote_rate": mapped_votes / total_votes if total_votes else 0,
            "duplicate_subject_ids": duplicate_subject_ids,
            "rejected_duplicate_mal_ids": duplicate_mal_ids,
            "direct_id_records": len(direct_index),
            "gamer_ids": frame["gamer_id"].drop_nulls().n_unique(),
        },
        "output": {
            "path": str(output.resolve()),
            "bytes": output.stat().st_size,
            "sha256": _sha256(output),
        },
    }
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    temporary_manifest = manifest_output.with_suffix(
        manifest_output.suffix + ".tmp"
    )
    temporary_manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_manifest.replace(manifest_output)
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Map Bangumi aggregate-rating subjects to the MAL catalog."
    )
    result.add_argument("subject_directory", type=Path)
    result.add_argument("catalog", type=Path)
    result.add_argument("--bangumi-data", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--manifest", required=True, type=Path)
    result.add_argument("--source-url", required=True)
    result.add_argument("--source-revision", required=True)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    manifest = build_mapping(
        subject_directory=args.subject_directory,
        catalog_path=args.catalog,
        bangumi_data_path=args.bangumi_data,
        output=args.output,
        manifest_output=args.manifest,
        source_url=args.source_url,
        source_revision=args.source_revision,
    )
    print(json.dumps(manifest["statistics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
