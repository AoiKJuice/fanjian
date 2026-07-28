from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import duckdb
import numpy as np
import polars as pl


def progress(message: str) -> None:
    print(
        f"[{datetime.now(UTC).isoformat(timespec='seconds')}] {message}",
        flush=True,
    )


def sha256(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def quote_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "''")


def build_catalog(source: Path, output: Path) -> dict:
    frame = pl.read_csv(
        source,
        infer_schema_length=20_000,
        null_values=["", "UNKNOWN", "Unknown"],
    )
    required = {
        "animeID",
        "title",
        "alternative_title",
        "type",
        "year",
        "score",
        "episodes",
        "mal_url",
        "sequel",
        "image_url",
        "genres",
        "genres_detailed",
    }
    missing_columns = required.difference(frame.columns)
    if missing_columns:
        raise ValueError(
            f"作品表缺少字段: {', '.join(sorted(missing_columns))}"
        )

    catalog = frame.select(
        pl.col("animeID").cast(pl.Int32).alias("anime_id"),
        pl.col("mal_url")
        .str.extract(r"/anime/(\d+)", 1)
        .cast(pl.Int32, strict=False)
        .alias("mal_id"),
        pl.col("title").cast(pl.String),
        pl.col("alternative_title").cast(pl.String),
        pl.col("type").cast(pl.String).str.to_uppercase().alias("format"),
        pl.col("year").cast(pl.Int32, strict=False),
        pl.col("episodes").cast(pl.Int32, strict=False),
        pl.col("score").cast(pl.Float32, strict=False).alias("source_score"),
        pl.col("mal_url").cast(pl.String),
        pl.col("image_url").cast(pl.String),
        pl.col("sequel").cast(pl.Boolean, strict=False).fill_null(False),
        pl.col("genres").cast(pl.String),
        pl.col("genres_detailed").cast(pl.String),
    ).sort("anime_id")

    rows = catalog.height
    unique_anime_ids = catalog["anime_id"].n_unique()
    null_anime_ids = catalog["anime_id"].null_count()
    null_mal_ids = catalog["mal_id"].null_count()
    duplicate_mal_ids = (
        catalog.filter(pl.col("mal_id").is_not_null())
        .group_by("mal_id")
        .len()
        .filter(pl.col("len") > 1)
        .height
    )
    if null_anime_ids or unique_anime_ids != rows:
        raise ValueError(
            "作品表 anime_id 不完整或重复，已拒绝生成模型产物。"
        )
    if null_mal_ids or duplicate_mal_ids:
        raise ValueError(
            "作品表 MAL ID 存在空值或重复，已拒绝生成模型产物。"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    catalog.write_parquet(output, compression="zstd", statistics=True)
    return {
        "rows": rows,
        "unique_anime_ids": unique_anime_ids,
        "unique_mal_ids": catalog["mal_id"].n_unique(),
        "null_anime_ids": null_anime_ids,
        "null_mal_ids": null_mal_ids,
        "duplicate_mal_ids": duplicate_mal_ids,
    }


def write_sparse_orientation(
    connection: duckdb.DuckDBPyConnection,
    query: str,
    output: Path,
    prefix: str,
    major_size: int,
    nnz: int,
    batch_size: int,
) -> None:
    data = np.lib.format.open_memmap(
        output / f"{prefix}_residuals.npy",
        mode="w+",
        dtype=np.float32,
        shape=(nnz,),
    )
    ratings = np.lib.format.open_memmap(
        output / f"{prefix}_ratings.npy",
        mode="w+",
        dtype=np.float32,
        shape=(nnz,),
    )
    indices = np.lib.format.open_memmap(
        output / f"{prefix}_indices.npy",
        mode="w+",
        dtype=np.int32,
        shape=(nnz,),
    )
    counts = np.zeros(major_size, dtype=np.int64)

    cursor = connection.execute(query)
    offset = 0
    while batch := cursor.fetchmany(batch_size):
        size = len(batch)
        major = np.fromiter(
            (row[0] for row in batch), dtype=np.int64, count=size
        )
        indices[offset : offset + size] = np.fromiter(
            (row[1] for row in batch), dtype=np.int32, count=size
        )
        data[offset : offset + size] = np.fromiter(
            (row[2] for row in batch), dtype=np.float32, count=size
        )
        ratings[offset : offset + size] = np.fromiter(
            (row[3] for row in batch), dtype=np.float32, count=size
        )
        counts += np.bincount(major, minlength=major_size)
        offset += size

    if offset != nnz:
        raise RuntimeError(f"{prefix} 写入 {offset} 条，预期 {nnz} 条。")

    indptr = np.lib.format.open_memmap(
        output / f"{prefix}_indptr.npy",
        mode="w+",
        dtype=np.int64,
        shape=(major_size + 1,),
    )
    indptr[0] = 0
    np.cumsum(counts, out=indptr[1:])
    data.flush()
    ratings.flush()
    indices.flush()
    indptr.flush()


def save_parameter_arrays(
    connection: duckdb.DuckDBPyConnection,
    output: Path,
    user_count: int,
    item_count: int,
    global_mean: float,
) -> None:
    user_rows = connection.execute(
        """
        SELECT
            u.user_idx,
            u.user_id,
            u.user_bias,
            u.user_scale,
            avg(r.rating) AS rating_mean
        FROM user_map u
        JOIN ratings r USING (user_id)
        GROUP BY u.user_idx, u.user_id, u.user_bias, u.user_scale
        ORDER BY user_idx
        """
    ).fetchall()
    if len(user_rows) != user_count:
        raise RuntimeError("用户参数数量与用户映射不一致。")
    np.save(
        output / "user_ids.npy",
        np.fromiter((row[1] for row in user_rows), dtype=np.int64),
    )
    np.save(
        output / "user_bias.npy",
        np.fromiter((row[2] for row in user_rows), dtype=np.float32),
    )
    np.save(
        output / "user_scale.npy",
        np.fromiter((row[3] for row in user_rows), dtype=np.float32),
    )
    np.save(
        output / "user_rating_mean.npy",
        np.fromiter((row[4] for row in user_rows), dtype=np.float32),
    )

    item_rows = connection.execute(
        """
        SELECT
            item_idx,
            anime_id,
            mal_id,
            coalesce(item_bias, 0.0),
            coalesce(rating_count, 0),
            coalesce(rating_mean, 0.0)
        FROM item_map
        ORDER BY item_idx
        """
    ).fetchall()
    if len(item_rows) != item_count:
        raise RuntimeError("作品参数数量与完整作品表不一致。")
    np.save(
        output / "anime_ids.npy",
        np.fromiter((row[1] for row in item_rows), dtype=np.int32),
    )
    np.save(
        output / "mal_ids.npy",
        np.fromiter((row[2] for row in item_rows), dtype=np.int32),
    )
    np.save(
        output / "item_bias.npy",
        np.fromiter((row[3] for row in item_rows), dtype=np.float32),
    )
    item_counts = np.fromiter(
        (row[4] for row in item_rows), dtype=np.int64
    )
    np.save(output / "item_counts.npy", item_counts)
    np.save(
        output / "item_rating_mean.npy",
        np.fromiter((row[5] for row in item_rows), dtype=np.float32),
    )

    iuf = np.log((user_count + 1) / (item_counts + 1)).astype(np.float32)
    np.save(output / "item_iuf.npy", iuf)

    surprise_counts = np.ones((item_count, 3), dtype=np.int64)
    for item_idx, bucket, count in connection.execute(
        """
        SELECT
            item_idx,
            CASE
                WHEN residual <= -0.7 THEN 0
                WHEN residual >= 0.7 THEN 2
                ELSE 1
            END AS bucket,
            count(*) AS event_count
        FROM residual_ratings
        GROUP BY item_idx, bucket
        """
    ).fetchall():
        surprise_counts[item_idx, bucket] += count
    totals = surprise_counts.sum(axis=1, keepdims=True)
    surprise = -np.log(surprise_counts / totals).astype(np.float32)
    np.save(output / "item_surprise.npy", surprise)
    (output / "global_mean.txt").write_text(
        f"{global_mean:.12f}\n", encoding="utf-8"
    )


def build_artifacts(
    ratings_source: Path,
    anime_source: Path,
    output: Path,
    min_user_ratings: int,
    min_user_stddev: float,
    min_score_bins: int,
    min_item_ratings: int,
    batch_size: int,
    source_url: str,
    license_note: str,
    data_version: str | None = None,
) -> dict:
    if output.exists():
        raise FileExistsError(
            f"输出目录已存在，拒绝覆盖: {output.resolve()}"
        )
    output.mkdir(parents=True)
    work = output / "_work"
    work.mkdir()
    (work / "tmp").mkdir()
    catalog_path = output / "catalog.parquet"

    try:
        progress("构建完整作品主表")
        catalog_stats = build_catalog(anime_source, catalog_path)
        database_path = work / "training.duckdb"
        connection = duckdb.connect(str(database_path))
        connection.execute("PRAGMA threads=4")
        connection.execute(
            f"PRAGMA temp_directory='{quote_path(work / 'tmp')}'"
        )
        connection.execute(
            (
                f"""
            CREATE VIEW raw_ratings AS
            SELECT
                cast(userID AS BIGINT) AS user_id,
                cast(animeID AS INTEGER) AS anime_id,
                cast(rating AS REAL) AS rating
            FROM read_parquet('{quote_path(ratings_source)}')
            WHERE rating > 0 AND rating <= 10
            """
                if ratings_source.suffix.lower() == ".parquet"
                else f"""
            CREATE VIEW raw_ratings AS
            SELECT
                cast(userID AS BIGINT) AS user_id,
                cast(animeID AS INTEGER) AS anime_id,
                cast(rating AS REAL) AS rating
            FROM read_csv_auto(
                '{quote_path(ratings_source)}',
                header=true,
                sample_size=100000
            )
            WHERE rating > 0 AND rating <= 10
            """
            )
        )
        connection.execute(
            f"""
            CREATE TABLE catalog AS
            SELECT * FROM read_parquet('{quote_path(catalog_path)}')
            """
        )

        progress("审计评分行数与作品 ID 覆盖")
        raw_count = connection.execute(
            "SELECT count(*) FROM raw_ratings"
        ).fetchone()[0]
        unknown_items = connection.execute(
            """
            SELECT count(*)
            FROM raw_ratings r
            ANTI JOIN catalog c USING (anime_id)
            """
        ).fetchone()[0]
        if unknown_items:
            raise ValueError(
                f"评分表中有 {unknown_items} 条记录找不到作品，已拒绝继续。"
            )
        progress("合并重复用户作品评分")
        connection.execute(
            """
            CREATE TABLE deduplicated_ratings AS
            SELECT
                user_id,
                anime_id,
                cast(median(rating) AS REAL) AS rating,
                count(*) AS source_rows,
                count(DISTINCT rating) AS distinct_scores
            FROM raw_ratings
            GROUP BY user_id, anime_id
            """
        )
        (
            deduplicated_count,
            duplicate_pairs,
            duplicate_extra_rows,
            exact_duplicate_pairs,
            conflicting_pairs,
            maximum_copies,
        ) = connection.execute(
            """
            SELECT
                count(*) AS deduplicated_count,
                count(*) FILTER (WHERE source_rows > 1) AS duplicate_pairs,
                coalesce(sum(source_rows - 1), 0) AS duplicate_extra_rows,
                count(*) FILTER (
                    WHERE source_rows > 1 AND distinct_scores = 1
                ) AS exact_duplicate_pairs,
                count(*) FILTER (
                    WHERE source_rows > 1 AND distinct_scores > 1
                ) AS conflicting_pairs,
                max(source_rows) AS maximum_copies
            FROM deduplicated_ratings
            """
        ).fetchone()
        maximum_score_gap = connection.execute(
            """
            SELECT coalesce(max(max_score - min_score), 0)
            FROM (
                SELECT
                    user_id,
                    anime_id,
                    min(rating) AS min_score,
                    max(rating) AS max_score
                FROM raw_ratings
                GROUP BY user_id, anime_id
                HAVING count(DISTINCT rating) > 1
            )
            """
        ).fetchone()[0]

        progress("计算用户与作品过滤统计")
        connection.execute(
            """
            CREATE TABLE user_stats AS
            SELECT
                user_id,
                count(*) AS rating_count,
                stddev_pop(rating) AS rating_stddev,
                count(DISTINCT cast(round(rating) AS INTEGER)) AS score_bins
            FROM deduplicated_ratings
            GROUP BY user_id
            """
        )
        connection.execute(
            f"""
            CREATE TABLE eligible_users AS
            SELECT user_id
            FROM user_stats
            WHERE rating_count >= {int(min_user_ratings)}
              AND rating_stddev >= {float(min_user_stddev)}
              AND score_bins >= {int(min_score_bins)}
            """
        )
        connection.execute(
            """
            CREATE TABLE item_stats AS
            SELECT r.anime_id, count(*) AS rating_count
            FROM deduplicated_ratings r
            JOIN eligible_users u USING (user_id)
            GROUP BY r.anime_id
            """
        )
        cleaned_path = output / "ratings.parquet"
        progress("写入清洗后的 Parquet 评分")
        connection.execute(
            f"""
            COPY (
                SELECT r.user_id, r.anime_id, r.rating
                FROM deduplicated_ratings r
                JOIN eligible_users u USING (user_id)
                JOIN item_stats i USING (anime_id)
                WHERE i.rating_count >= {int(min_item_ratings)}
            )
            TO '{quote_path(cleaned_path)}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)
            """
        )
        connection.execute(
            f"""
            CREATE VIEW ratings AS
            SELECT * FROM read_parquet('{quote_path(cleaned_path)}')
            """
        )
        cleaned_count = connection.execute(
            "SELECT count(*) FROM ratings"
        ).fetchone()[0]
        user_count = connection.execute(
            "SELECT count(DISTINCT user_id) FROM ratings"
        ).fetchone()[0]
        rated_item_count = connection.execute(
            "SELECT count(DISTINCT anime_id) FROM ratings"
        ).fetchone()[0]
        if not cleaned_count or not user_count:
            raise ValueError("过滤后没有可训练评分。")

        global_mean = float(
            connection.execute("SELECT avg(rating) FROM ratings").fetchone()[0]
        )
        progress("拟合全局、用户与作品偏差")
        connection.execute(
            f"""
            CREATE TABLE user_biases AS
            SELECT
                user_id,
                (sum(rating) - count(*) * {global_mean})
                    / (count(*) + 10.0) AS user_bias
            FROM ratings
            GROUP BY user_id
            """
        )
        connection.execute(
            f"""
            CREATE TABLE item_biases AS
            SELECT
                r.anime_id,
                sum(r.rating - {global_mean} - u.user_bias)
                    / (count(*) + 15.0) AS item_bias,
                count(*) AS rating_count,
                avg(r.rating) AS rating_mean
            FROM ratings r
            JOIN user_biases u USING (user_id)
            GROUP BY r.anime_id
            """
        )
        connection.execute(
            f"""
            CREATE TABLE raw_residuals AS
            SELECT
                r.user_id,
                r.anime_id,
                r.rating,
                r.rating - {global_mean} - u.user_bias - i.item_bias
                    AS raw_residual
            FROM ratings r
            JOIN user_biases u USING (user_id)
            JOIN item_biases i USING (anime_id)
            """
        )
        connection.execute(
            """
            CREATE TABLE user_scales AS
            SELECT
                user_id,
                greatest(stddev_pop(raw_residual), 0.5) AS user_scale
            FROM raw_residuals
            GROUP BY user_id
            """
        )
        connection.execute(
            """
            CREATE TABLE item_map AS
            SELECT
                row_number() OVER (ORDER BY c.anime_id) - 1 AS item_idx,
                c.anime_id,
                c.mal_id,
                i.item_bias,
                i.rating_count,
                i.rating_mean
            FROM catalog c
            LEFT JOIN item_biases i USING (anime_id)
            ORDER BY c.anime_id
            """
        )
        connection.execute(
            """
            CREATE TABLE user_map AS
            SELECT
                row_number() OVER (ORDER BY u.user_id) - 1 AS user_idx,
                u.user_id,
                u.user_bias,
                s.user_scale
            FROM user_biases u
            JOIN user_scales s USING (user_id)
            ORDER BY u.user_id
            """
        )
        residual_path = output / "residuals.parquet"
        progress("计算标准化评分残差")
        connection.execute(
            f"""
            COPY (
                SELECT
                    u.user_idx,
                    i.item_idx,
                    r.rating,
                    r.raw_residual / u.user_scale AS residual
                FROM raw_residuals r
                JOIN user_map u USING (user_id)
                JOIN item_map i USING (anime_id)
            )
            TO '{quote_path(residual_path)}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)
            """
        )
        connection.execute(
            f"""
            CREATE VIEW residual_ratings AS
            SELECT * FROM read_parquet('{quote_path(residual_path)}')
            """
        )

        item_count = catalog_stats["rows"]
        progress("写入用户到作品 CSR 索引")
        write_sparse_orientation(
            connection,
            """
            SELECT user_idx, item_idx, residual, rating
            FROM residual_ratings
            ORDER BY user_idx, item_idx
            """,
            output,
            "csr",
            user_count,
            cleaned_count,
            batch_size,
        )
        progress("写入作品到用户 CSC 索引")
        write_sparse_orientation(
            connection,
            """
            SELECT item_idx, user_idx, residual, rating
            FROM residual_ratings
            ORDER BY item_idx, user_idx
            """,
            output,
            "csc",
            item_count,
            cleaned_count,
            batch_size,
        )
        progress("写入 IUF、事件稀有度与校准参数")
        save_parameter_arrays(
            connection, output, user_count, item_count, global_mean
        )
        connection.close()
        shutil.rmtree(work)

        manifest = {
            "created_at": datetime.now(UTC).isoformat(),
            "data_version": data_version,
            "source_url": source_url,
            "license_note": license_note,
            "inputs": {
                "ratings": {
                    "path": str(ratings_source.resolve()),
                    "bytes": ratings_source.stat().st_size,
                    "sha256": sha256(ratings_source),
                },
                "anime": {
                    "path": str(anime_source.resolve()),
                    "bytes": anime_source.stat().st_size,
                    "sha256": sha256(anime_source),
                },
            },
            "filters": {
                "rating_range": [1, 10],
                "min_user_ratings": min_user_ratings,
                "min_user_stddev": min_user_stddev,
                "min_score_bins": min_score_bins,
                "min_item_ratings": min_item_ratings,
            },
            "catalog": catalog_stats,
            "ratings": {
                "raw_valid_rows": raw_count,
                "deduplicated_rows": deduplicated_count,
                "cleaned_rows": cleaned_count,
                "users": user_count,
                "rated_items": rated_item_count,
                "catalog_items": item_count,
                "unknown_item_rows": unknown_items,
                "duplicate_pairs": duplicate_pairs,
                "duplicate_extra_rows": duplicate_extra_rows,
                "exact_duplicate_pairs": exact_duplicate_pairs,
                "conflicting_pairs": conflicting_pairs,
                "maximum_copies": maximum_copies,
                "maximum_score_gap": maximum_score_gap,
                "conflict_resolution": "median",
            },
            "calibration": {
                "global_mean": global_mean,
                "user_bias_regularization": 10,
                "item_bias_regularization": 15,
                "minimum_user_scale": 0.5,
            },
        }
        (output / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        progress("模型产物构建完成")
        return manifest
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Build complete catalog and disk-backed UserKNN artifacts."
    )
    result.add_argument("ratings", type=Path)
    result.add_argument("anime", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--min-user-ratings", type=int, default=20)
    result.add_argument("--min-user-stddev", type=float, default=0.5)
    result.add_argument("--min-score-bins", type=int, default=3)
    result.add_argument("--min-item-ratings", type=int, default=20)
    result.add_argument("--batch-size", type=int, default=250_000)
    result.add_argument("--source-url", required=True)
    result.add_argument("--license-note", required=True)
    result.add_argument("--data-version")
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    manifest = build_artifacts(
        ratings_source=args.ratings,
        anime_source=args.anime,
        output=args.output,
        min_user_ratings=args.min_user_ratings,
        min_user_stddev=args.min_user_stddev,
        min_score_bins=args.min_score_bins,
        min_item_ratings=args.min_item_ratings,
        batch_size=args.batch_size,
        source_url=args.source_url,
        license_note=args.license_note,
        data_version=args.data_version,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
