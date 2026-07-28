from __future__ import annotations

import argparse
import json
import math
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np
import polars as pl


REPLACED_FILES = {
    "anime_ids.npy",
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


def _link_or_copy(source: Path, target: Path) -> None:
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _current_record(
    row: dict,
    anime_id: int,
    sequel: bool,
    source_label: str,
) -> dict:
    explicit = _text(row.get("explicit_genres"))
    rating = row.get("rating") or ""
    return {
        "anime_id": anime_id,
        "mal_id": int(row["mal_id"]),
        "title": row.get("title"),
        "alternative_title": row.get("title_japanese"),
        "format": (
            row.get("type") or row.get("format") or "UNKNOWN"
        ).upper(),
        "year": row.get("year"),
        "episodes": row.get("episodes"),
        "source_score": row.get("score"),
        "mal_url": row.get("url"),
        "image_url": row.get("image_url"),
        "sequel": sequel,
        "genres": _text(row.get("genres")),
        "genres_detailed": " | ".join(
            filter(
                None,
                [
                    _text(row.get("themes")),
                    _text(row.get("demographics")),
                    explicit,
                ],
            )
        ),
        "release_status": row.get("status"),
        "synopsis": row.get("synopsis"),
        "is_adult": "Hentai" in explicit or str(rating).startswith("Rx"),
        "catalog_source": source_label,
    }


def expand_catalog(
    source_artifact: Path,
    current_catalog_csv: Path,
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
        current = (
            pl.read_parquet(current_catalog_csv)
            if current_catalog_csv.suffix.lower() == ".parquet"
            else pl.read_csv(
                current_catalog_csv,
                infer_schema_length=50_000,
                ignore_errors=False,
            )
        )
        source_label = (
            "tenrai-current"
            if current_catalog_csv.suffix.lower() == ".parquet"
            else "kaggle-anime-dataset-2025"
        )
        if (
            current["mal_id"].null_count()
            or current["mal_id"].n_unique() != current.height
        ):
            raise ValueError("当前作品表 MAL ID 存在空值或重复。")

        current_by_id = {
            int(row["mal_id"]): row
            for row in current.iter_rows(named=True)
        }
        old_rows = list(old_catalog.iter_rows(named=True))
        old_ids = {int(row["mal_id"]) for row in old_rows}
        records = []
        missing_from_current = []
        for row in old_rows:
            mal_id = int(row["mal_id"])
            fresh = current_by_id.get(mal_id)
            if fresh:
                records.append(
                    _current_record(
                        fresh,
                        anime_id=int(row["anime_id"]),
                        sequel=bool(row["sequel"]),
                        source_label=source_label,
                    )
                )
            else:
                missing_from_current.append(mal_id)
                records.append(
                    {
                        **row,
                        "release_status": None,
                        "synopsis": None,
                        "is_adult": "Hentai" in (row["genres"] or ""),
                        "catalog_source": "ratings-dataset-preserved",
                    }
                )

        next_anime_id = max(int(row["anime_id"]) for row in old_rows) + 1
        added_ids = sorted(set(current_by_id).difference(old_ids))
        for offset, mal_id in enumerate(added_ids):
            records.append(
                _current_record(
                    current_by_id[mal_id],
                    anime_id=next_anime_id + offset,
                    sequel=False,
                    source_label=source_label,
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
            raise ValueError("扩展作品表未通过 ID 完整性检查。")

        for source in source_artifact.iterdir():
            if (
                source.is_file()
                and source.name not in REPLACED_FILES
            ):
                _link_or_copy(source, output / source.name)

        catalog.write_parquet(
            output / "catalog.parquet",
            compression="zstd",
            statistics=True,
        )
        old_count = old_catalog.height
        new_count = catalog.height
        added_count = new_count - old_count
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
        manifest["parent_artifact"] = str(source_artifact.resolve())
        manifest["catalog"] = {
            "rows": new_count,
            "unique_anime_ids": catalog["anime_id"].n_unique(),
            "unique_mal_ids": catalog["mal_id"].n_unique(),
            "null_anime_ids": catalog["anime_id"].null_count(),
            "null_mal_ids": catalog["mal_id"].null_count(),
            "duplicate_mal_ids": 0,
            "training_catalog_rows": old_count,
            "current_snapshot_rows": current.height,
            "added_current_rows": added_count,
            "preserved_training_rows_absent_from_snapshot": len(
                missing_from_current
            ),
            "snapshot_path": str(current_catalog_csv.resolve()),
        }
        manifest["ratings"] = {
            **old_manifest["ratings"],
            "catalog_items": new_count,
        }
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
        description="Expand a trained artifact without changing rating indexes."
    )
    result.add_argument("source_artifact", type=Path)
    result.add_argument("current_catalog_csv", type=Path)
    result.add_argument("--output", required=True, type=Path)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = expand_catalog(
        args.source_artifact,
        args.current_catalog_csv,
        args.output,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
