from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import httpx
import polars as pl


DEFAULT_SOURCE = "https://api.tenrai.org/v1/anime"


def _valid_page(path: Path, page: int) -> dict | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if (
        payload.get("pagination", {}).get("current_page") != page
        or not isinstance(payload.get("data"), list)
    ):
        return None
    return payload


def _write_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary.replace(path)


def _fetch_page(
    client: httpx.Client,
    source: str,
    page: int,
    attempts: int,
    query: dict[str, str | int] | None = None,
) -> dict:
    for attempt in range(1, attempts + 1):
        try:
            response = client.get(
                source,
                params={"page": page, "limit": 25, **(query or {})},
            )
            if response.status_code == 200:
                payload = response.json()
                if payload.get("pagination", {}).get("current_page") == page:
                    return payload
            retry_after = response.headers.get("Retry-After")
            delay = (
                float(retry_after)
                if retry_after
                else min(30.0, 1.5 * 2 ** min(attempt - 1, 4))
            )
            print(
                f"page={page} attempt={attempt} "
                f"http={response.status_code} retry={delay:.1f}s",
                flush=True,
            )
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            delay = min(30.0, 1.5 * 2 ** min(attempt - 1, 4))
            print(
                f"page={page} attempt={attempt} "
                f"error={type(exc).__name__} retry={delay:.1f}s",
                flush=True,
            )
        time.sleep(delay + random.random() * 0.25)
    raise RuntimeError(f"目录第 {page} 页连续 {attempts} 次失败。")


def _row(item: dict) -> dict:
    aired = item.get("aired") or {}
    images = item.get("images") or {}
    jpg = images.get("jpg") or {}
    titles = {
        value.get("type"): value.get("title")
        for value in item.get("titles") or []
    }
    return {
        "mal_id": item.get("mal_id"),
        "title": item.get("title"),
        "title_english": item.get("title_english")
        or titles.get("English"),
        "title_japanese": item.get("title_japanese")
        or titles.get("Japanese"),
        "format": item.get("type"),
        "episodes": item.get("episodes"),
        "status": item.get("status"),
        "airing": item.get("airing"),
        "year": item.get("year"),
        "season": item.get("season"),
        "start_date": (aired.get("from") or "")[:10] or None,
        "end_date": (aired.get("to") or "")[:10] or None,
        "score": item.get("score"),
        "scored_by": item.get("scored_by"),
        "members": item.get("members"),
        "synopsis": item.get("synopsis"),
        "rating": item.get("rating"),
        "url": item.get("url"),
        "image_url": jpg.get("large_image_url")
        or jpg.get("image_url"),
        "genres": [
            value.get("name") for value in item.get("genres") or []
        ],
        "explicit_genres": [
            value.get("name")
            for value in item.get("explicit_genres") or []
        ],
        "themes": [
            value.get("name") for value in item.get("themes") or []
        ],
        "demographics": [
            value.get("name")
            for value in item.get("demographics") or []
        ],
    }


def download(
    output_directory: Path,
    attempts: int,
    source: str = DEFAULT_SOURCE,
    request_interval: float = 1.05,
) -> dict:
    pages = output_directory / "pages"
    pages.mkdir(parents=True, exist_ok=True)
    started = datetime.now(UTC)
    with httpx.Client(
        timeout=60,
        headers={"User-Agent": "anime-affinity-research/0.1"},
        follow_redirects=True,
    ) as client:
        first_path = pages / "page-0001.json"
        first = _valid_page(first_path, 1)
        if first is None:
            first = _fetch_page(client, source, 1, attempts)
            _write_json(first_path, first)
        last_page = int(first["pagination"]["last_visible_page"])
        advertised_total = int(first["pagination"]["items"]["total"])
        print(
            f"pages={last_page} advertised_total={advertised_total}",
            flush=True,
        )
        ascending_pages = min(last_page, 1000)
        for page in range(2, ascending_pages + 1):
            path = pages / f"page-{page:04d}.json"
            if _valid_page(path, page) is not None:
                continue
            payload = _fetch_page(client, source, page, attempts)
            _write_json(path, payload)
            if page % 25 == 0 or page == last_page:
                print(f"downloaded={page}/{last_page}", flush=True)
            time.sleep(request_interval)

        reverse_pages = 0
        reverse_advertised_total = advertised_total
        if last_page > ascending_pages:
            reverse_directory = output_directory / "pages-desc"
            reverse_directory.mkdir(parents=True, exist_ok=True)
            # Two overlap pages prove the ascending and descending segments meet.
            reverse_pages = (
                math.ceil(
                    max(0, advertised_total - ascending_pages * 25) / 25
                )
                + 2
            )
            for page in range(1, reverse_pages + 1):
                path = reverse_directory / f"page-{page:04d}.json"
                payload = _valid_page(path, page)
                if payload is None:
                    payload = _fetch_page(
                        client,
                        source,
                        page,
                        attempts,
                        query={"order_by": "mal_id", "sort": "desc"},
                    )
                    _write_json(path, payload)
                    time.sleep(request_interval)
                reverse_advertised_total = int(
                    payload["pagination"]["items"]["total"]
                )
                if page % 25 == 0 or page == reverse_pages:
                    print(
                        f"downloaded_desc={page}/{reverse_pages}",
                        flush=True,
                    )

    records: dict[int, dict] = {}
    total_response_bytes = 0
    ascending_ids: set[int] = set()
    descending_ids: set[int] = set()
    for page in range(1, ascending_pages + 1):
        path = pages / f"page-{page:04d}.json"
        payload = _valid_page(path, page)
        if payload is None:
            raise RuntimeError(f"第 {page} 页文件损坏或缺失。")
        total_response_bytes += path.stat().st_size
        for item in payload["data"]:
            mal_id = int(item["mal_id"])
            ascending_ids.add(mal_id)
            records[mal_id] = _row(item)
    if reverse_pages:
        reverse_directory = output_directory / "pages-desc"
        for page in range(1, reverse_pages + 1):
            path = reverse_directory / f"page-{page:04d}.json"
            payload = _valid_page(path, page)
            if payload is None:
                raise RuntimeError(f"倒序第 {page} 页文件损坏或缺失。")
            total_response_bytes += path.stat().st_size
            for item in payload["data"]:
                mal_id = int(item["mal_id"])
                descending_ids.add(mal_id)
                records[mal_id] = _row(item)
        if not ascending_ids.intersection(descending_ids):
            raise RuntimeError("正序和倒序分页没有重叠，无法证明目录连续。")

    # The source can add or retire entries during a long crawl. The descending
    # segment is fetched last, so its advertised total is the completion
    # snapshot. Preserve both totals in the manifest for auditability.
    required_total = reverse_advertised_total
    if len(records) < required_total:
        raise RuntimeError(
            f"分页公布至少 {required_total} 部，去重后只有 {len(records)} 部。"
        )

    frame = pl.DataFrame(list(records.values())).sort("mal_id")
    catalog_path = output_directory / "catalog.parquet"
    frame.write_parquet(
        catalog_path, compression="zstd", statistics=True
    )
    digest = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "started_at": started.isoformat(),
        "source": source,
        "advertised_total": advertised_total,
        "reverse_advertised_total": reverse_advertised_total,
        "unique_mal_ids": frame["mal_id"].n_unique(),
        "rows": frame.height,
        "pages": ascending_pages,
        "reverse_pages": reverse_pages,
        "segment_overlap_ids": len(
            ascending_ids.intersection(descending_ids)
        ),
        "response_bytes": total_response_bytes,
        "catalog_bytes": catalog_path.stat().st_size,
        "catalog_sha256": digest,
    }
    (output_directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Download the complete current Jikan anime pagination."
    )
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--attempts", type=int, default=12)
    result.add_argument("--source", default=DEFAULT_SOURCE)
    result.add_argument("--request-interval", type=float, default=1.05)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    download(
        args.output,
        args.attempts,
        source=args.source,
        request_interval=args.request_interval,
    )


if __name__ == "__main__":
    main()
