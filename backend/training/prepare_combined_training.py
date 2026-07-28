from __future__ import annotations

import argparse
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import duckdb
import polars as pl

from backend.training.build_artifacts import quote_path, sha256


def _catalog_source(base_catalog: Path, output: Path) -> None:
    catalog = pl.read_parquet(base_catalog)
    required = {
        "anime_id",
        "mal_id",
        "title",
        "alternative_title",
        "format",
        "year",
        "source_score",
        "episodes",
        "mal_url",
        "sequel",
        "image_url",
        "genres",
        "genres_detailed",
    }
    missing = required.difference(catalog.columns)
    if missing:
        raise RuntimeError(
            "基础作品目录缺少字段: " + ", ".join(sorted(missing))
        )
    catalog.select(
        pl.col("anime_id").alias("animeID"),
        "title",
        "alternative_title",
        pl.col("format").alias("type"),
        "year",
        pl.col("source_score").alias("score"),
        "episodes",
        "mal_url",
        "sequel",
        "image_url",
        "genres",
        "genres_detailed",
    ).write_csv(output)


def prepare(
    base_artifact: Path,
    supplemental_ratings: Path,
    output_directory: Path,
    source_name: str,
    license_note: str,
) -> dict:
    if output_directory.exists():
        raise FileExistsError(
            f"输出目录已存在，拒绝覆盖: {output_directory.resolve()}"
        )
    output_directory.mkdir(parents=True)
    ratings_output = output_directory / "combined-ratings.parquet"
    catalog_output = output_directory / "catalog-source.csv"
    database = output_directory / "_prepare.duckdb"
    base_ratings = base_artifact / "ratings.parquet"
    base_catalog = base_artifact / "catalog.parquet"
    for required in (base_ratings, base_catalog, supplemental_ratings):
        if not required.exists():
            raise FileNotFoundError(required)

    try:
        _catalog_source(base_catalog, catalog_output)
        connection = duckdb.connect(str(database))
        connection.execute("PRAGMA threads=4")
        connection.execute(
            f"""
            CREATE VIEW base_ratings AS
            SELECT
                cast(user_id AS BIGINT) AS user_id,
                cast(anime_id AS INTEGER) AS anime_id,
                cast(rating AS REAL) AS rating
            FROM read_parquet('{quote_path(base_ratings)}')
            """
        )
        connection.execute(
            f"""
            CREATE VIEW catalog AS
            SELECT mal_id, anime_id
            FROM read_parquet('{quote_path(base_catalog)}')
            """
        )
        connection.execute(
            f"""
            CREATE VIEW supplemental_source AS
            SELECT
                cast(user_hash AS VARCHAR) AS user_hash,
                cast(mal_id AS INTEGER) AS mal_id,
                cast(rating_10 AS REAL) AS rating
            FROM read_parquet('{quote_path(supplemental_ratings)}')
            WHERE rating_10 BETWEEN 1 AND 10
            """
        )
        unknown_rows = connection.execute(
            """
            SELECT count(*)
            FROM supplemental_source s
            ANTI JOIN catalog c USING (mal_id)
            """
        ).fetchone()[0]
        if unknown_rows:
            raise RuntimeError(
                f"附加评分有 {unknown_rows} 行无法映射到完整 MAL 目录。"
            )
        base_max_user_id = int(
            connection.execute(
                "SELECT coalesce(max(user_id), 0) FROM base_ratings"
            ).fetchone()[0]
        )
        connection.execute(
            f"""
            CREATE TABLE supplemental_user_map AS
            SELECT
                user_hash,
                {base_max_user_id}
                    + row_number() OVER (ORDER BY user_hash) AS user_id
            FROM (
                SELECT DISTINCT user_hash
                FROM supplemental_source
            )
            """
        )
        base_rows = int(
            connection.execute(
                "SELECT count(*) FROM base_ratings"
            ).fetchone()[0]
        )
        supplemental_rows = int(
            connection.execute(
                "SELECT count(*) FROM supplemental_source"
            ).fetchone()[0]
        )
        supplemental_users = int(
            connection.execute(
                "SELECT count(*) FROM supplemental_user_map"
            ).fetchone()[0]
        )
        supplemental_items = int(
            connection.execute(
                "SELECT count(DISTINCT mal_id) FROM supplemental_source"
            ).fetchone()[0]
        )
        connection.execute(
            f"""
            COPY (
                SELECT
                    user_id AS userID,
                    anime_id AS animeID,
                    rating
                FROM base_ratings
                UNION ALL
                SELECT
                    u.user_id AS userID,
                    c.anime_id AS animeID,
                    s.rating
                FROM supplemental_source s
                JOIN supplemental_user_map u USING (user_hash)
                JOIN catalog c USING (mal_id)
            )
            TO '{quote_path(ratings_output)}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)
            """
        )
        connection.close()
        database.unlink(missing_ok=True)

        manifest = {
            "created_at": datetime.now(UTC).isoformat(),
            "base_artifact": str(base_artifact.resolve()),
            "base_manifest": json.loads(
                (base_artifact / "manifest.json").read_text(encoding="utf-8")
            ),
            "supplemental_source": {
                "name": source_name,
                "license_note": license_note,
                "path": str(supplemental_ratings.resolve()),
                "bytes": supplemental_ratings.stat().st_size,
                "sha256": sha256(supplemental_ratings),
                "rows": supplemental_rows,
                "users_before_training_filter": supplemental_users,
                "items": supplemental_items,
                "unknown_catalog_rows": unknown_rows,
                "user_namespace": (
                    f"integer IDs greater than {base_max_user_id}"
                ),
            },
            "combined": {
                "base_rows": base_rows,
                "rows": base_rows + supplemental_rows,
                "ratings_path": str(ratings_output.resolve()),
                "ratings_bytes": ratings_output.stat().st_size,
                "ratings_sha256": sha256(ratings_output),
                "catalog_path": str(catalog_output.resolve()),
                "catalog_bytes": catalog_output.stat().st_size,
                "catalog_sha256": sha256(catalog_output),
            },
        }
        (output_directory / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return manifest
    except Exception:
        shutil.rmtree(output_directory, ignore_errors=True)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Namespace and combine a base artifact with supplemental "
            "MAL-keyed per-user ratings."
        )
    )
    result.add_argument("--base-artifact", required=True, type=Path)
    result.add_argument("--supplemental-ratings", required=True, type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--source-name", required=True)
    result.add_argument("--license-note", required=True)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    manifest = prepare(
        args.base_artifact,
        args.supplemental_ratings,
        args.output,
        args.source_name,
        args.license_note,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
