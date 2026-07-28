from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx


ANILIST_ENDPOINT = "https://graphql.anilist.co"

LIST_QUERY = """
query UserAnimeList($name: String!) {
  MediaListCollection(userName: $name, type: ANIME) {
    lists {
      entries {
        score
        status
        updatedAt
        media {
          id
          idMal
          title { native english romaji }
          format
          episodes
          status
          seasonYear
          isAdult
        }
      }
    }
  }
}
"""

RELATIONS_QUERY = """
query Relations($ids: [Int]) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: ANIME) {
      idMal
      relations {
        edges {
          relationType(version: 2)
          node { idMal type format }
        }
      }
    }
  }
}
"""


STATUS_MAP = {
    "COMPLETED": "completed",
    "CURRENT": "watching",
    "DROPPED": "dropped",
    "PAUSED": "on_hold",
    "PLANNING": "plan_to_watch",
    "REPEATING": "watching",
}


class AniListError(RuntimeError):
    pass


@dataclass
class CacheEntry:
    expires_at: float
    value: dict


class AniListClient:
    def __init__(self) -> None:
        self._relation_cache: dict[tuple[int, ...], CacheEntry] = {}

    async def _post(self, query: str, variables: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            for attempt in range(2):
                response = await client.post(
                    ANILIST_ENDPOINT,
                    json={"query": query, "variables": variables},
                    headers={"User-Agent": "AnimeAffinityLab/0.1 local-research"},
                )
                if response.status_code == 429 and attempt == 0:
                    wait = min(float(response.headers.get("Retry-After", "1")), 5)
                    await asyncio.sleep(wait)
                    continue
                if response.status_code >= 400:
                    raise AniListError(
                        f"AniList 返回 HTTP {response.status_code}"
                    )
                payload = response.json()
                if payload.get("errors"):
                    message = payload["errors"][0].get("message", "查询失败")
                    raise AniListError(f"AniList 查询失败：{message}")
                return payload["data"]
        raise AniListError("AniList 请求超过限流等待时间")

    async def import_user(self, username: str) -> list[dict]:
        data = await self._post(LIST_QUERY, {"name": username})
        collection = data.get("MediaListCollection")
        if not collection:
            raise AniListError("找不到该 AniList 用户或列表不可见")
        entries = [
            entry
            for group in collection.get("lists") or []
            for entry in group.get("entries") or []
        ]
        output = []
        for entry in entries:
            media = entry.get("media") or {}
            output.append(
                {
                    "mal_id": media.get("idMal"),
                    "anilist_id": media.get("id"),
                    "rating": entry.get("score") or None,
                    "status": STATUS_MAP.get(
                        entry.get("status"), "plan_to_watch"
                    ),
                    "updated_at": entry.get("updatedAt"),
                }
            )
        return output

    async def relations(self, mal_ids: list[int]) -> dict:
        key = tuple(sorted(set(mal_ids)))
        cached = self._relation_cache.get(key)
        if cached and cached.expires_at > time.monotonic():
            return cached.value
        data = await self._post(RELATIONS_QUERY, {"ids": list(key)})
        self._relation_cache[key] = CacheEntry(
            expires_at=time.monotonic() + 1800,
            value=data,
        )
        return data
