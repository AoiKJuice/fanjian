from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import httpx
import duckdb
import polars as pl


DETAIL_URL = "https://acg.gamer.com.tw/acgDetail.php"
REVIEWS_URL = "https://api.gamer.com.tw/acg/v1/reviews_list.php"
REVIEW_PATTERN = re.compile(
    r"new\s+Bahamut\.AcgReview\("
    r"[^,]+,\s*(?P<count>\d+)\s*,\s*"
    r"(?P<stars>\{[^}]+\})\s*,\s*"
    r"(?P<review_id>\d+)\s*,\s*(?P<media_type>\d+)\s*\)"
)


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    try:
        for attempt in range(10):
            try:
                temporary.replace(path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def _append_jsonl(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    values: list[dict] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"{path} 第 {line_number} 行不是有效 JSON。"
                ) from exc
            if not isinstance(value, dict):
                raise RuntimeError(
                    f"{path} 第 {line_number} 行不是 JSON object。"
                )
            values.append(value)
    return values


def _private_salt(path: Path) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        salt = path.read_bytes()
        if len(salt) < 32:
            raise RuntimeError("巴哈姆特用户哈希盐少于 32 bytes。")
        return salt
    salt = os.urandom(32)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(salt)
    temporary.replace(path)
    return salt


def _user_hash(user_id: str, salt: bytes) -> str:
    return hashlib.blake2b(
        user_id.encode("utf-8"),
        digest_size=16,
        key=salt,
        person=b"bahamut-rating",
    ).hexdigest()


def _request(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, int],
    attempts: int,
) -> httpx.Response:
    for attempt in range(1, attempts + 1):
        try:
            response = client.get(url, params=params)
            if response.status_code == 200:
                return response
            retry_after = response.headers.get("Retry-After")
            delay = (
                float(retry_after)
                if retry_after
                else min(60.0, 1.5 * (2 ** min(attempt - 1, 5)))
            )
            print(
                f"http={response.status_code} attempt={attempt} "
                f"retry={delay:.1f}s url={response.url}",
                flush=True,
            )
        except httpx.HTTPError as exc:
            delay = min(60.0, 1.5 * (2 ** min(attempt - 1, 5)))
            print(
                f"error={type(exc).__name__} attempt={attempt} "
                f"retry={delay:.1f}s",
                flush=True,
            )
        time.sleep(delay + random.random() * 0.3)
    raise RuntimeError(f"{url} 连续 {attempts} 次请求失败。")


def _review_entries(payload: dict) -> tuple[list[dict], int | None, dict]:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("巴哈姆特 review API 缺少 data object。")
    raw_rows = data.get("list") or []
    rows: list[dict] = []
    for raw_row in raw_rows:
        row = (
            raw_row[0]
            if isinstance(raw_row, list) and raw_row
            else raw_row
        )
        if not isinstance(row, dict):
            continue
        publisher = row.get("publisher") or {}
        reviews = row.get("reviews") or {}
        user_id = publisher.get("id")
        rating = reviews.get("rating")
        if (
            isinstance(user_id, str)
            and user_id
            and isinstance(rating, (int, float))
            and 1 <= float(rating) <= 5
        ):
            rows.append(
                {
                    "user_id": user_id,
                    "rating": int(rating),
                    "updated_at": row.get("ctime"),
                }
            )
    next_page = data.get("page")
    return (
        rows,
        int(next_page) if isinstance(next_page, int) else None,
        data.get("rating") or {},
    )


def _mapping_rows(
    mapping_path: Path,
) -> tuple[list[dict[str, int]], list[dict[str, int]]]:
    frame = (
        pl.scan_parquet(mapping_path)
        .filter(
            pl.col("gamer_id").is_not_null()
            & pl.col("mal_id").is_not_null()
        )
        .select(
            pl.col("gamer_id").cast(pl.Int64),
            pl.col("mal_id").cast(pl.Int64),
        )
        .unique()
        .collect()
        .sort(["gamer_id", "mal_id"])
    )
    duplicate_ids = (
        frame.group_by("gamer_id")
        .len()
        .filter(pl.col("len") > 1)
        .select("gamer_id")
    )
    ambiguous = frame.join(
        duplicate_ids, on="gamer_id", how="semi"
    ).sort(["gamer_id", "mal_id"])
    unambiguous = frame.join(
        duplicate_ids, on="gamer_id", how="anti"
    ).sort(["gamer_id", "mal_id"])
    return unambiguous.to_dicts(), ambiguous.to_dicts()


def _write_outputs(
    output_directory: Path,
    aggregate_rows: list[dict],
    ratings_checkpoint: Path,
    *,
    mapping_path: Path,
    salt_path: Path,
    started_at: datetime,
    mapping_count: int,
    ambiguous_mapping_rows: list[dict[str, int]],
) -> dict:
    output_directory.mkdir(parents=True, exist_ok=True)
    aggregates = (
        pl.DataFrame(aggregate_rows)
        .unique(subset=["gamer_id"], keep="last")
        .sort("gamer_id")
        if aggregate_rows
        else pl.DataFrame(
            schema={
                "gamer_id": pl.Int64,
                "mal_id": pl.Int64,
                "review_id": pl.Int64,
                "media_type": pl.Int64,
                "aggregate_rating_count": pl.Int64,
                "aggregate_average": pl.Float64,
                "score_1_count": pl.Int64,
                "score_2_count": pl.Int64,
                "score_3_count": pl.Int64,
                "score_4_count": pl.Int64,
                "score_5_count": pl.Int64,
                "public_review_ratings": pl.Int64,
                "pages": pl.Int64,
                "status": pl.String,
            }
        )
    )
    aggregate_path = output_directory / "bahamut-aggregates.parquet"
    ratings_path = output_directory / "bahamut-user-ratings.parquet"
    aggregate_temp = aggregate_path.with_suffix(".parquet.tmp")
    ratings_temp = ratings_path.with_suffix(".parquet.tmp")
    aggregates.write_parquet(aggregate_temp, compression="zstd")
    aggregate_temp.replace(aggregate_path)

    rating_rows = 0
    distinct_users = 0
    usable_users = 0
    usable_ratings = 0
    if ratings_checkpoint.exists() and ratings_checkpoint.stat().st_size:
        database = output_directory / "_finalize.duckdb"
        connection = duckdb.connect(str(database))
        connection.execute("PRAGMA threads=4")
        checkpoint_sql = str(
            ratings_checkpoint.resolve()
        ).replace("'", "''")
        ratings_temp_sql = str(ratings_temp.resolve()).replace("'", "''")
        connection.execute(
            f"""
            COPY (
                SELECT
                    cast(user_hash AS VARCHAR) AS user_hash,
                    cast(mal_id AS INTEGER) AS mal_id,
                    cast(rating AS TINYINT) AS rating,
                    cast(rating_10 AS TINYINT) AS rating_10,
                    cast(updated_at AS VARCHAR) AS updated_at
                FROM read_ndjson_auto('{checkpoint_sql}')
                QUALIFY row_number() OVER (
                    PARTITION BY user_hash, mal_id
                    ORDER BY updated_at DESC NULLS LAST
                ) = 1
                ORDER BY user_hash, mal_id
            )
            TO '{ratings_temp_sql}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)
            """
        )
        ratings_temp.replace(ratings_path)
        ratings_sql = str(ratings_path.resolve()).replace("'", "''")
        connection.execute(
            f"""
            CREATE VIEW finalized_ratings AS
            SELECT * FROM read_parquet('{ratings_sql}')
            """
        )
        rating_rows, distinct_users = connection.execute(
            """
            SELECT count(*), count(DISTINCT user_hash)
            FROM finalized_ratings
            """
        ).fetchone()
        usable_users, usable_ratings = connection.execute(
            """
            WITH user_stats AS (
                SELECT
                    user_hash,
                    count(*) AS ratings,
                    stddev_pop(rating_10) AS rating_std,
                    count(DISTINCT rating_10) AS rating_values
                FROM finalized_ratings
                GROUP BY user_hash
            ),
            usable AS (
                SELECT user_hash, ratings
                FROM user_stats
                WHERE ratings >= 20
                  AND rating_std >= 0.5
                  AND rating_values >= 3
            )
            SELECT count(*), coalesce(sum(ratings), 0)
            FROM usable
            """
        ).fetchone()
        connection.close()
        database.unlink(missing_ok=True)
    else:
        pl.DataFrame(
            schema={
                "user_hash": pl.String,
                "mal_id": pl.Int64,
                "rating": pl.Int8,
                "rating_10": pl.Int8,
                "updated_at": pl.String,
            }
        ).write_parquet(ratings_temp, compression="zstd")
        ratings_temp.replace(ratings_path)

    aggregate_rating_count = (
        int(aggregates["aggregate_rating_count"].sum())
        if aggregates.height
        else 0
    )
    public_review_count = int(rating_rows)
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "started_at": started_at.isoformat(),
        "sources": {
            "detail": DETAIL_URL,
            "reviews": REVIEWS_URL,
        },
        "mapping_file": str(mapping_path.resolve()),
        "mapping_sha256": hashlib.sha256(
            mapping_path.read_bytes()
        ).hexdigest(),
        "mapped_gamer_items": mapping_count,
        "ambiguous_gamer_ids_excluded": len(
            {row["gamer_id"] for row in ambiguous_mapping_rows}
        ),
        "ambiguous_mapping_rows": ambiguous_mapping_rows,
        "processed_gamer_items": aggregates.height,
        "items_with_rating_widget": aggregates.filter(
            pl.col("status") == "complete"
        ).height,
        "aggregate_rating_count": aggregate_rating_count,
        "public_user_rating_rows": public_review_count,
        "public_to_aggregate_ratio": (
            public_review_count / aggregate_rating_count
            if aggregate_rating_count
            else None
        ),
        "distinct_hashed_users": (
            int(distinct_users)
        ),
        "users_passing_training_filter": usable_users,
        "ratings_from_users_passing_filter": usable_ratings,
        "rating_scale": {
            "source": "integer 1-5",
            "normalized": "source rating multiplied by 2",
        },
        "privacy": {
            "stored_user_identifier": "keyed BLAKE2b, 128-bit digest",
            "salt_file": str(salt_path.resolve()),
            "salt_in_manifest": False,
            "stored_profile_fields": [],
            "stored_comment_text": False,
        },
        "license_and_use": (
            "Local non-commercial research only. Raw responses and user "
            "profiles are not redistributed."
        ),
        "outputs": {
            "aggregates": {
                "path": str(aggregate_path.resolve()),
                "rows": aggregates.height,
                "sha256": hashlib.sha256(
                    aggregate_path.read_bytes()
                ).hexdigest(),
            },
            "user_ratings": {
                "path": str(ratings_path.resolve()),
                "rows": int(rating_rows),
                "sha256": hashlib.sha256(
                    ratings_path.read_bytes()
                ).hexdigest(),
            },
        },
    }
    _atomic_json(output_directory / "manifest.json", manifest)
    return manifest


def download(
    mapping_path: Path,
    output_directory: Path,
    checkpoint_directory: Path,
    salt_path: Path,
    *,
    attempts: int,
    request_interval: float,
    max_items: int | None,
    max_pages_per_item: int,
) -> dict:
    if request_interval < 0.5:
        raise ValueError("request_interval 不得低于 0.5 秒。")
    mapping, ambiguous_mapping_rows = _mapping_rows(mapping_path)
    if max_items is not None:
        mapping = mapping[:max_items]
    aggregate_checkpoint = checkpoint_directory / "items.jsonl"
    ratings_checkpoint = checkpoint_directory / "ratings.jsonl"
    active_checkpoint = checkpoint_directory / "active-item.json"
    aggregate_rows = _read_jsonl(aggregate_checkpoint)
    completed = {
        int(row["gamer_id"])
        for row in aggregate_rows
        if row.get("status") in {"complete", "no_rating_widget"}
    }
    salt = _private_salt(salt_path)
    started_at = datetime.now(UTC)

    with httpx.Client(
        timeout=45,
        follow_redirects=True,
        headers={
            "User-Agent": "anime-affinity-research/0.1 "
            "(local non-commercial research)",
            "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
        },
    ) as client:
        pending = [
            row for row in mapping if int(row["gamer_id"]) not in completed
        ]
        for position, mapping_row in enumerate(pending, start=1):
            gamer_id = int(mapping_row["gamer_id"])
            mal_id = int(mapping_row["mal_id"])
            response = _request(
                client,
                DETAIL_URL,
                params={"s": gamer_id},
                attempts=attempts,
            )
            match = REVIEW_PATTERN.search(response.text)
            time.sleep(request_interval + random.random() * 0.15)
            if match is None:
                aggregate = {
                    "gamer_id": gamer_id,
                    "mal_id": mal_id,
                    "review_id": None,
                    "media_type": None,
                    "aggregate_rating_count": 0,
                    "aggregate_average": None,
                    **{f"score_{star}_count": 0 for star in range(1, 6)},
                    "public_review_ratings": 0,
                    "pages": 0,
                    "status": "no_rating_widget",
                }
                _append_jsonl(aggregate_checkpoint, aggregate)
                aggregate_rows.append(aggregate)
                print(
                    f"[{position}/{len(pending)}] gamer={gamer_id} "
                    "no_rating_widget",
                    flush=True,
                )
                continue

            aggregate_count = int(match.group("count"))
            stars = json.loads(match.group("stars"))
            review_id = int(match.group("review_id"))
            media_type = int(match.group("media_type"))
            active = (
                json.loads(active_checkpoint.read_text(encoding="utf-8"))
                if active_checkpoint.exists()
                else {}
            )
            resuming = int(active.get("gamer_id", -1)) == gamer_id
            page = int(active["next_page"]) if resuming else 1
            pages = int(active.get("pages", 0)) if resuming else 0
            item_ratings: list[dict] = [
                row
                for row in (
                    pl.scan_ndjson(ratings_checkpoint)
                    .filter(pl.col("mal_id") == mal_id)
                    .collect()
                    .to_dicts()
                    if resuming and ratings_checkpoint.exists()
                    else []
                )
            ]
            seen_pages: set[int] = set()
            api_rating: dict = {}
            while page and page not in seen_pages:
                if pages >= max_pages_per_item:
                    raise RuntimeError(
                        f"gamer_id={gamer_id} 超过 "
                        f"{max_pages_per_item} 个 review pages。"
                    )
                seen_pages.add(page)
                review_response = _request(
                    client,
                    REVIEWS_URL,
                    params={
                        "sn": review_id,
                        "t": media_type,
                        "page": page,
                        "sort": 1,
                    },
                    attempts=attempts,
                )
                try:
                    payload = review_response.json()
                except json.JSONDecodeError as exc:
                    raise RuntimeError(
                        f"gamer_id={gamer_id} review API 不是 JSON。"
                    ) from exc
                entries, next_page, api_rating = _review_entries(payload)
                for entry in entries:
                    row = {
                        "user_hash": _user_hash(
                            entry.pop("user_id"), salt
                        ),
                        "mal_id": mal_id,
                        "rating": entry["rating"],
                        "rating_10": entry["rating"] * 2,
                        "updated_at": entry["updated_at"],
                    }
                    _append_jsonl(ratings_checkpoint, row)
                    item_ratings.append(row)
                pages += 1
                page = next_page
                _atomic_json(
                    active_checkpoint,
                    {
                        "gamer_id": gamer_id,
                        "mal_id": mal_id,
                        "review_id": review_id,
                        "media_type": media_type,
                        "next_page": page,
                        "pages": pages,
                    },
                )
                time.sleep(request_interval + random.random() * 0.15)

            api_count = api_rating.get("count")
            if isinstance(api_count, int):
                aggregate_count = max(aggregate_count, api_count)
            item_ratings = list(
                {
                    (row["user_hash"], int(row["mal_id"])): row
                    for row in item_ratings
                }.values()
            )
            aggregate = {
                "gamer_id": gamer_id,
                "mal_id": mal_id,
                "review_id": review_id,
                "media_type": media_type,
                "aggregate_rating_count": aggregate_count,
                "aggregate_average": api_rating.get("avg"),
                **{
                    f"score_{star}_count": int(
                        (api_rating.get("star_chart") or stars).get(
                            str(star), 0
                        )
                    )
                    for star in range(1, 6)
                },
                "public_review_ratings": len(item_ratings),
                "pages": pages,
                "status": "complete",
            }
            _append_jsonl(aggregate_checkpoint, aggregate)
            aggregate_rows.append(aggregate)
            active_checkpoint.unlink(missing_ok=True)
            print(
                f"[{position}/{len(pending)}] gamer={gamer_id} "
                f"aggregate={aggregate_count} "
                f"public={len(item_ratings)} pages={pages}",
                flush=True,
            )

    manifest = _write_outputs(
        output_directory,
        aggregate_rows,
        ratings_checkpoint,
        mapping_path=mapping_path,
        salt_path=salt_path,
        started_at=started_at,
        mapping_count=len(mapping),
        ambiguous_mapping_rows=ambiguous_mapping_rows,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Download mapped Bahamut aggregate ratings and public "
            "per-user review ratings with resumable checkpoints."
        )
    )
    result.add_argument("--mapping", required=True, type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--checkpoint", required=True, type=Path)
    result.add_argument("--salt", required=True, type=Path)
    result.add_argument("--attempts", type=int, default=10)
    result.add_argument("--request-interval", type=float, default=1.05)
    result.add_argument("--max-items", type=int)
    result.add_argument("--max-pages-per-item", type=int, default=5000)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    download(
        args.mapping,
        args.output,
        args.checkpoint,
        args.salt,
        attempts=args.attempts,
        request_interval=args.request_interval,
        max_items=args.max_items,
        max_pages_per_item=args.max_pages_per_item,
    )


if __name__ == "__main__":
    main()
