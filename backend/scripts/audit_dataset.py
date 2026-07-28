from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import polars as pl


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit and normalize a public anime rating dataset."
    )
    parser.add_argument("ratings", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--license-note", required=True)
    parser.add_argument("--min-user-ratings", type=int, default=20)
    parser.add_argument("--min-user-stddev", type=float, default=0.5)
    parser.add_argument("--min-item-ratings", type=int, default=20)
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    scan = (
        pl.scan_csv(args.ratings)
        if args.ratings.suffix.lower() == ".csv"
        else pl.scan_parquet(args.ratings)
    )
    normalized = scan.select(
        pl.col("user_id").cast(pl.Int64),
        pl.col("anime_id").alias("mal_id").cast(pl.Int64),
        pl.col("rating").cast(pl.Float32),
    ).filter(pl.col("rating").is_between(1, 10))
    user_stats = normalized.group_by("user_id").agg(
        pl.len().alias("rating_count"),
        pl.col("rating").std().alias("rating_stddev"),
        pl.col("rating").round(0).n_unique().alias("score_bins"),
    )
    valid_users = user_stats.filter(
        (pl.col("rating_count") >= args.min_user_ratings)
        & (pl.col("rating_stddev") >= args.min_user_stddev)
        & (pl.col("score_bins") >= 3)
    ).select("user_id")
    filtered = normalized.join(valid_users, on="user_id")
    valid_items = (
        filtered.group_by("mal_id")
        .len()
        .filter(pl.col("len") >= args.min_item_ratings)
        .select("mal_id")
    )
    filtered = filtered.join(valid_items, on="mal_id")
    filtered.sink_parquet(args.output, compression="zstd")

    final = pl.scan_parquet(args.output).select(
        pl.len().alias("ratings"),
        pl.col("user_id").n_unique().alias("users"),
        pl.col("mal_id").n_unique().alias("anime"),
    ).collect().row(0, named=True)
    manifest = {
        "source_url": args.source_url,
        "license_note": args.license_note,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "input_file": args.ratings.name,
        "input_bytes": args.ratings.stat().st_size,
        "input_sha256": sha256(args.ratings),
        "output_file": args.output.name,
        "output_bytes": args.output.stat().st_size,
        "output_sha256": sha256(args.output),
        "filters": {
            "valid_rating_range": [1, 10],
            "min_user_ratings": args.min_user_ratings,
            "min_user_stddev": args.min_user_stddev,
            "min_integer_score_bins": 3,
            "min_item_ratings": args.min_item_ratings,
        },
        "result": final,
    }
    manifest_path = args.output.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
