import { searchBrowserCatalog } from "./model-client";
import type { ImportPreview, RatingItem, WatchStatus } from "./api";

const ANILIST_QUERY = `
query UserAnimeList($name: String!) {
  MediaListCollection(userName: $name, type: ANIME) {
    lists { entries { score status updatedAt media { idMal } } }
  }
}`;

const anilistStatuses: Record<string, WatchStatus> = {
  COMPLETED: "completed",
  CURRENT: "watching",
  DROPPED: "dropped",
  PAUSED: "on_hold",
  PLANNING: "plan_to_watch",
  REPEATING: "watching",
};

const bangumiStatuses: Record<number, WatchStatus> = {
  1: "plan_to_watch",
  2: "completed",
  3: "watching",
  4: "on_hold",
  5: "dropped",
};

export async function importAniListInBrowser(username: string): Promise<ImportPreview> {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { name: username } }),
  });
  if (!response.ok) throw new Error(`AniList 返回 HTTP ${response.status}`);
  const payload = await response.json() as {
    data?: { MediaListCollection?: { lists?: Array<{ entries?: Array<{
      score?: number;
      status?: string;
      media?: { idMal?: number | null };
    }> }> } };
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) throw new Error(payload.errors[0].message ?? "AniList 导入失败");
  const entries = payload.data?.MediaListCollection?.lists
    ?.flatMap((list) => list.entries ?? []) ?? [];
  const mapped = new Map<number, RatingItem>();
  let unmapped = 0;
  let unrated = 0;
  let duplicates = 0;
  for (const entry of entries) {
    const malId = entry.media?.idMal;
    if (!malId) {
      unmapped++;
      continue;
    }
    if (mapped.has(malId)) duplicates++;
    const rating = entry.score && entry.score > 0 ? entry.score : null;
    if (rating == null) unrated++;
    mapped.set(malId, {
      mal_id: malId,
      rating,
      status: anilistStatuses[entry.status ?? ""] ?? "plan_to_watch",
    });
  }
  return {
    imported: mapped.size,
    unmapped,
    duplicates,
    unrated,
    items: [...mapped.values()],
    unmapped_items: [],
    warnings: [],
  };
}

export async function importBangumiInBrowser(
  username: string,
  accessToken?: string,
): Promise<ImportPreview> {
  const entries: Array<{
    subject_id: number;
    rate?: number;
    type?: number;
    subject?: {
      name?: string;
      name_cn?: string;
      date?: string;
      images?: { large?: string; common?: string; medium?: string };
    };
  }> = [];
  let offset = 0;
  while (true) {
    const url = new URL(
      `https://api.bgm.tv/v0/users/${encodeURIComponent(username)}/collections`,
    );
    url.searchParams.set("subject_type", "2");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    });
    if (!response.ok) throw new Error(`Bangumi 返回 HTTP ${response.status}`);
    const payload = await response.json() as { data?: typeof entries; total?: number };
    const page = payload.data ?? [];
    entries.push(...page);
    offset += page.length;
    if (!page.length || offset >= (payload.total ?? 0)) break;
  }
  const items: RatingItem[] = [];
  const unmappedItems: ImportPreview["unmapped_items"] = [];
  let unrated = 0;
  for (const entry of entries) {
    const subject = entry.subject ?? {};
    const title = subject.name_cn || subject.name || `Bangumi #${entry.subject_id}`;
    const year = Number(subject.date?.slice(0, 4)) || null;
    const candidates = (await searchBrowserCatalog(title, 12)).items;
    const exact = candidates.filter((candidate) =>
      [candidate.title_zh, candidate.title_native, candidate.title_en]
        .filter(Boolean)
        .some((value) => normalizeTitle(value) === normalizeTitle(title)),
    );
    const sameYear = year == null ? exact : exact.filter((candidate) => candidate.year === year);
    const matched = sameYear.length === 1 ? sameYear[0] : exact.length === 1 ? exact[0] : null;
    const rating = entry.rate && entry.rate >= 1 ? entry.rate : null;
    if (rating == null) unrated++;
    const status = bangumiStatuses[entry.type ?? 0] ?? "plan_to_watch";
    if (matched) {
      items.push({ mal_id: matched.mal_id, rating, status });
    } else {
      unmappedItems.push({
        source: "bangumi",
        external_id: String(entry.subject_id),
        title,
        title_native: subject.name ?? null,
        rating,
        status,
        cover_url: subject.images?.large || subject.images?.common || subject.images?.medium || null,
      });
    }
  }
  return {
    imported: entries.length,
    unmapped: unmappedItems.length,
    duplicates: 0,
    unrated,
    items,
    unmapped_items: unmappedItems,
    warnings: [],
  };
}

export async function importMalInBrowser(file: File): Promise<ImportPreview> {
  const document = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (document.querySelector("parsererror")) throw new Error("MAL XML 文件无法解析");
  const statusMap: Record<string, WatchStatus> = {
    Completed: "completed",
    Watching: "watching",
    Dropped: "dropped",
    "On-Hold": "on_hold",
    "Plan to Watch": "plan_to_watch",
  };
  let unrated = 0;
  const items = [...document.querySelectorAll("anime")].flatMap((node) => {
    const malId = Number(node.querySelector("series_animedb_id")?.textContent);
    if (!malId) return [];
    const score = Number(node.querySelector("my_score")?.textContent);
    const rating = score > 0 ? score : null;
    if (rating == null) unrated++;
    return [{
      mal_id: malId,
      rating,
      status: statusMap[node.querySelector("my_status")?.textContent ?? ""] ?? "plan_to_watch",
    } satisfies RatingItem];
  });
  return {
    imported: items.length,
    unmapped: 0,
    duplicates: 0,
    unrated,
    items,
    unmapped_items: [],
    warnings: [],
  };
}

function normalizeTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
