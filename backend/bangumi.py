from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Iterable

import httpx
import polars as pl


BANGUMI_ENDPOINT = "https://api.bgm.tv"
USER_AGENT = "AnimeAffinityLab/0.1 local-research"
LOGGER = logging.getLogger(__name__)

STATUS_MAP = {
    1: "plan_to_watch",
    2: "completed",
    3: "watching",
    4: "on_hold",
    5: "dropped",
}


class BangumiError(RuntimeError):
    pass


class BangumiMappingUnavailable(BangumiError):
    pass


def _normalize_title(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").casefold()
    return re.sub(r"[^\w]+", "", normalized)


def _year(value: object) -> int | None:
    text = str(value or "")
    return int(text[:4]) if len(text) >= 4 and text[:4].isdigit() else None


class BangumiClient:
    def __init__(
        self,
        mapping_path: str | Path | None = None,
        catalog_path: str | Path | None = None,
        *,
        mapping: dict[int, int] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._transport = transport
        self._mapping = dict(mapping or {})
        self._mal_to_subject: dict[int, int] = {
            mal_id: subject_id
            for subject_id, mal_id in self._mapping.items()
        }
        self._title_index: dict[str, list[tuple[int, int | None]]] = {}

        if mapping_path:
            path = Path(mapping_path)
            if path.exists():
                frame = pl.read_parquet(
                    path, columns=["bangumi_subject_id", "mal_id"]
                ).filter(pl.col("mal_id").is_not_null())
                self._mapping.update(
                    {
                        int(subject_id): int(mal_id)
                        for subject_id, mal_id in frame.iter_rows()
                    }
                )
                for subject_id, mal_id in self._mapping.items():
                    self._mal_to_subject.setdefault(mal_id, subject_id)

        if catalog_path:
            path = Path(catalog_path)
            if path.exists():
                catalog = pl.read_parquet(
                    path,
                    columns=[
                        "mal_id",
                        "title",
                        "alternative_title",
                        "year",
                    ],
                )
                title_index: dict[
                    str, set[tuple[int, int | None]]
                ] = defaultdict(set)
                for row in catalog.iter_rows(named=True):
                    candidate = (int(row["mal_id"]), row["year"])
                    for title in (row["title"], row["alternative_title"]):
                        normalized = _normalize_title(title)
                        if normalized:
                            title_index[normalized].add(candidate)
                self._title_index = {
                    title: sorted(candidates)
                    for title, candidates in title_index.items()
                }

    async def _get(
        self,
        path: str,
        *,
        params: dict[str, int],
        access_token: str | None,
        not_found_message: str = "找不到该 Bangumi 用户",
    ) -> dict:
        headers = {"User-Agent": USER_AGENT}
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        async with httpx.AsyncClient(
            base_url=BANGUMI_ENDPOINT,
            timeout=20,
            transport=self._transport,
        ) as client:
            for attempt in range(3):
                try:
                    response = await client.get(
                        path, params=params, headers=headers
                    )
                except httpx.HTTPError as exc:
                    if attempt < 2:
                        await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    raise BangumiError(f"Bangumi 请求失败：{exc}") from exc
                if response.status_code == 429 and attempt < 2:
                    try:
                        wait = float(response.headers.get("Retry-After", "1"))
                    except ValueError:
                        wait = 1
                    await asyncio.sleep(min(max(wait, 0), 10))
                    continue
                if response.status_code == 404:
                    raise BangumiError(not_found_message)
                if response.status_code in {401, 403}:
                    raise BangumiError(
                        "Bangumi 收藏不可见；私密收藏需要有效的 Access Token"
                    )
                if response.status_code >= 400:
                    raise BangumiError(
                        f"Bangumi 返回 HTTP {response.status_code}"
                    )
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise BangumiError("Bangumi 返回了无法解析的数据") from exc
                if not isinstance(payload, dict):
                    raise BangumiError("Bangumi 返回的数据格式不符合 API 文档")
                return payload
        raise BangumiError("Bangumi 请求超过限流等待时间")

    async def subject_metadata(
        self,
        mal_ids: Iterable[int],
    ) -> dict[int, dict]:
        semaphore = asyncio.Semaphore(6)

        async def fetch(mal_id: int) -> tuple[int, dict | None]:
            subject_id = self._mal_to_subject.get(mal_id)
            if subject_id is None:
                return mal_id, None
            try:
                async with semaphore:
                    subject = await self._get(
                        f"/v0/subjects/{subject_id}",
                        params={},
                        access_token=None,
                        not_found_message="找不到该 Bangumi 条目",
                    )
            except BangumiError as exc:
                LOGGER.warning(
                    "Bangumi 条目读取失败 mal_id=%s subject_id=%s: %s",
                    mal_id,
                    subject_id,
                    exc,
                )
                return mal_id, None
            rating = subject.get("rating") or {}
            images = subject.get("images") or {}
            score = rating.get("score")
            return mal_id, {
                "bangumi_subject_id": subject_id,
                "bangumi_score": (
                    float(score)
                    if score is not None and float(score) > 0
                    else None
                ),
                "title_zh": subject.get("name_cn") or None,
                "title_native": subject.get("name") or None,
                "synopsis": subject.get("summary") or "",
                "cover_url": (
                    images.get("large")
                    or images.get("common")
                    or images.get("medium")
                ),
            }

        pairs = await asyncio.gather(
            *(fetch(int(mal_id)) for mal_id in dict.fromkeys(mal_ids))
        )
        return {
            mal_id: metadata
            for mal_id, metadata in pairs
            if metadata is not None
        }

    def _resolve_mal_id(self, collection: dict) -> tuple[int | None, str]:
        subject_id = int(collection.get("subject_id") or 0)
        direct = self._mapping.get(subject_id)
        if direct:
            return direct, "mapping"

        subject = collection.get("subject") or {}
        subject_year = _year(subject.get("date"))
        candidates: set[tuple[int, int | None]] = set()
        for title in (subject.get("name"), subject.get("name_cn")):
            normalized = _normalize_title(title)
            if normalized:
                candidates.update(self._title_index.get(normalized, []))
        if subject_year is not None:
            same_year = {
                candidate
                for candidate in candidates
                if candidate[1] == subject_year
            }
            if len(same_year) == 1:
                return next(iter(same_year))[0], "exact_title_and_year"
        if len(candidates) == 1:
            return next(iter(candidates))[0], "unique_exact_title"
        return None, "unmapped"

    async def import_user(
        self,
        username: str,
        access_token: str | None = None,
    ) -> list[dict]:
        if not self._mapping and not self._title_index:
            raise BangumiMappingUnavailable(
                "Bangumi→MAL 映射和本地番剧目录均不可用"
            )

        entries: list[dict] = []
        offset = 0
        page_size = 100
        while True:
            payload = await self._get(
                f"/v0/users/{username}/collections",
                params={
                    "subject_type": 2,
                    "limit": page_size,
                    "offset": offset,
                },
                access_token=access_token,
            )
            page = payload.get("data")
            if not isinstance(page, list):
                raise BangumiError("Bangumi 收藏响应缺少 data 列表")
            for collection in page:
                if not isinstance(collection, dict):
                    continue
                mal_id, mapping_method = self._resolve_mal_id(collection)
                raw_rating = int(collection.get("rate") or 0)
                subject = collection.get("subject") or {}
                images = subject.get("images") or {}
                entries.append(
                    {
                        "bangumi_subject_id": int(
                            collection.get("subject_id") or 0
                        ),
                        "mal_id": mal_id,
                        "rating": (
                            float(raw_rating)
                            if 1 <= raw_rating <= 10
                            else None
                        ),
                        "status": STATUS_MAP.get(
                            int(collection.get("type") or 0),
                            "plan_to_watch",
                        ),
                        "updated_at": collection.get("updated_at"),
                        "mapping_method": mapping_method,
                        "title": (
                            subject.get("name_cn")
                            or subject.get("name")
                            or f"Bangumi #{collection.get('subject_id')}"
                        ),
                        "title_native": subject.get("name"),
                        "cover_url": (
                            images.get("large")
                            or images.get("common")
                            or images.get("medium")
                        ),
                    }
                )
            total = int(payload.get("total") or 0)
            offset += len(page)
            if not page or offset >= total:
                break
            if offset > 100_000:
                raise BangumiError("Bangumi 收藏数量异常，已停止导入")
        return entries
