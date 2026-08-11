import type { Anime, Recommendation } from "./data";
import { enrichBrowserRecommendations } from "./anime-metadata";
import { browserModelEnabled } from "./browser-mode";
import {
  importAniListInBrowser,
  importBangumiInBrowser,
  importMalInBrowser,
} from "./browser-imports";
import {
  associateLocalExternalRating,
  createLocalProfile,
  deleteLocalProfile,
  deleteLocalRun,
  enrichCollections,
  enrichLibrary,
  listLocalProfiles,
  loadLocalExternalLibrary,
  loadLocalLibrary,
  loadLocalRun,
  localCollections,
  localExcluded,
  localNegativeItems,
  localRatingsMap,
  localRunHistory,
  removeLocalCollection,
  saveLocalRatings,
  saveLocalCollections,
  saveLocalRun,
  setLocalCollection,
} from "./local-db";
import {
  browserModelStatus,
  browserNeighborStats,
  loadBrowserAnime,
  loadBrowserAnimeMany,
  recommendInBrowser,
  searchBrowserCatalog,
} from "./model-client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export type RecommendationPayload = {
  items: Recommendation[];
  runId: number;
  source: "api";
};

export type RecommendationFilters = {
  format?: string;
  minimumSupport?: number;
  minimumBangumiScore?: number | null;
  minimumYear?: number | null;
  maximumYear?: number | null;
  includeShortForm?: boolean;
  excludeRelated?: boolean;
};

export function recommendationFilterRecord(
  filters: RecommendationFilters = {},
) {
  return {
    limit: 100,
    min_support: Math.max(5, filters.minimumSupport ?? 0),
    allow_sequels: true,
    formats: filters.format && filters.format !== "全部" ? [filters.format] : [],
    minimum_bangumi_score: filters.minimumBangumiScore ?? null,
    minimum_year: filters.minimumYear ?? null,
    maximum_year: filters.maximumYear ?? null,
    include_short_form: filters.includeShortForm ?? true,
    exclude_related: filters.excludeRelated ?? false,
  };
}

export type Profile = {
  id: number;
  name: string;
  title_language: string;
  rating_count: number;
  updated_at: string;
};

export type Insights = {
  rating_count: number;
  mean_rating: number;
  rating_stddev: number;
  distinct_integer_scores: number;
  quality: "高" | "中" | "低";
  neighbor_count: number;
  mean_overlap: number;
  histogram: Record<string, number>;
  mainstream_index: number;
  long_tail_ratio: number;
};

export type ModelCard = {
  model_version: string;
  data_version: string;
  algorithm: string;
  catalog_items: number;
  training_users: number;
  training_ratings: number;
};

export type LocalHealth = {
  status: "ok";
  model_version: string;
  data_version: string;
  catalog_items: number;
  training_users: number;
  training_ratings: number;
};

export type WatchStatus =
  | "completed"
  | "watching"
  | "dropped"
  | "on_hold"
  | "plan_to_watch";

export type RatingItem = {
  mal_id: number;
  rating: number | null;
  status: WatchStatus;
};

export type ImportPreview = {
  imported: number;
  unmapped: number;
  duplicates: number;
  unrated: number;
  items: RatingItem[];
  unmapped_items: ExternalRatingItem[];
  warnings: string[];
};

export type ExternalRatingItem = {
  source: "bangumi";
  external_id: string;
  title: string;
  title_native: string | null;
  rating: number | null;
  status: WatchStatus;
  cover_url: string | null;
};

export type ExternalLibraryItem = ExternalRatingItem & {
  updated_at: string;
};

export type LibraryItem = RatingItem & {
  updated_at: string;
  anime: Anime | null;
  favorite: number;
  hidden: number;
};

export type CollectionItem = {
  mal_id: number;
  created_at: string;
  anime: Anime | null;
};

export type ProfileCollections = {
  favorites: CollectionItem[];
  hidden: CollectionItem[];
};

export type ProfileCollectionIds = {
  favorites: number[];
  hidden: number[];
};

export type RecommendationHistoryItem = {
  id: number;
  profile_id: number;
  created_at: string;
  model_version: string;
  data_version: string;
  filters: string;
  status: "ready" | "insufficient";
  item_count: number;
};

export type RecommendationRun = {
  id: number;
  profile_id: number;
  created_at: string;
  model_version: string;
  data_version: string;
  status: "ready" | "insufficient";
  items: Recommendation[];
  filters?: string;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string }
      | null;
    throw new Error(payload?.detail ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function loadProfiles(): Promise<Profile[]> {
  if (browserModelEnabled) return listLocalProfiles();
  return requestJson<Profile[]>("/profiles");
}

export async function loadLocalHealth(): Promise<LocalHealth> {
  if (browserModelEnabled) {
    const status = await browserModelStatus();
    if (status.state !== "ready" || !status.manifest) throw new Error("模型尚未下载");
    return {
      status: "ok",
      model_version: status.manifest.model_version,
      data_version: status.manifest.data_version,
      catalog_items: status.manifest.catalog_items,
      training_users: status.manifest.training_users,
      training_ratings: status.manifest.training_ratings,
    };
  }
  return requestJson<LocalHealth>("/health");
}

export async function loadInsights(profileId: number): Promise<Insights> {
  if (browserModelEnabled) {
    const ratings = await localRatingsMap(profileId);
    const values = Object.values(ratings);
    const mean = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
    const deviation = values.length > 1
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
      : 0;
    const histogram = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [String(index + 1), 0]),
    );
    values.forEach((value) => {
      const key = String(Math.round(value));
      histogram[key] = (histogram[key] ?? 0) + 1;
    });
    const modelStatus = await browserModelStatus();
    const stats = modelStatus.state === "ready"
      ? await browserNeighborStats(ratings, await localNegativeItems(profileId))
      : {
          neighborCount: 0,
          meanOverlap: 0,
          mainstreamIndex: 0,
          longTailRatio: 0,
        };
    return {
      rating_count: values.length,
      mean_rating: Number(mean.toFixed(2)),
      rating_stddev: Number(deviation.toFixed(2)),
      distinct_integer_scores: new Set(values.map(Math.round)).size,
      quality: values.length >= 30 && deviation >= 0.75
        ? "高"
        : values.length >= 5 && deviation >= 0.5 ? "中" : "低",
      neighbor_count: stats.neighborCount,
      mean_overlap: stats.meanOverlap,
      histogram,
      mainstream_index: stats.mainstreamIndex,
      long_tail_ratio: stats.longTailRatio,
    };
  }
  return requestJson<Insights>(`/profiles/${profileId}/insights`);
}

export async function loadModelCard(): Promise<ModelCard> {
  if (browserModelEnabled) {
    const status = await browserModelStatus();
    if (!status.manifest) throw new Error("模型清单读取失败");
    return {
      model_version: status.manifest.model_version,
      data_version: status.manifest.data_version,
      algorithm: "surprise weighted userknn",
      catalog_items: status.manifest.catalog_items,
      training_users: status.manifest.training_users,
      training_ratings: status.manifest.training_ratings,
    };
  }
  return requestJson<ModelCard>("/system/model-card");
}

export async function createProfile(
  name: string,
  titleLanguage: "zh" | "native" | "en",
): Promise<Profile> {
  if (browserModelEnabled) return createLocalProfile(name, titleLanguage);
  return requestJson<Profile>("/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      title_language: titleLanguage,
    }),
  });
}

export async function deleteProfile(profileId: number): Promise<void> {
  if (browserModelEnabled) return deleteLocalProfile(profileId);
  const response = await fetch(`${API_BASE}/profiles/${profileId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function loadLibrary(profileId: number): Promise<LibraryItem[]> {
  if (browserModelEnabled) {
    const [rows, collections] = await Promise.all([
      loadLocalLibrary(profileId),
      localCollections(profileId),
    ]);
    const anime = await loadBrowserAnimeMany(rows.map((item) => item.mal_id));
    return enrichLibrary(
      rows,
      new Map(anime.map((item) => [item.mal_id, item])),
      collections,
    );
  }
  const payload = await requestJson<{ items: LibraryItem[] }>(
    `/profiles/${profileId}/library`,
  );
  return payload.items;
}

export async function loadUnmappedLibrary(
  profileId: number,
): Promise<ExternalLibraryItem[]> {
  if (browserModelEnabled) return loadLocalExternalLibrary(profileId);
  const payload = await requestJson<{
    unmapped_items: ExternalLibraryItem[];
  }>(`/profiles/${profileId}/library`);
  return payload.unmapped_items;
}

export async function associateExternalRating(
  profileId: number,
  item: Pick<ExternalLibraryItem, "source" | "external_id">,
  malId: number,
): Promise<void> {
  if (browserModelEnabled) {
    return associateLocalExternalRating(profileId, item, malId);
  }
  await requestJson(`/profiles/${profileId}/library/associate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: item.source,
      external_id: item.external_id,
      mal_id: malId,
    }),
  });
}

export async function loadCollections(
  profileId: number,
): Promise<ProfileCollections> {
  if (browserModelEnabled) {
    const collections = await localCollections(profileId);
    const ids = [...collections.favorites, ...collections.hidden].map((item) => item.mal_id);
    const anime = await loadBrowserAnimeMany(ids);
    return enrichCollections(
      collections,
      new Map(anime.map((item) => [item.mal_id, item])),
    );
  }
  return requestJson<ProfileCollections>(
    `/profiles/${profileId}/collections`,
  );
}

export async function loadProfileExportData(profileId: number) {
  if (browserModelEnabled) {
    const [ratings, collections] = await Promise.all([
      loadLocalLibrary(profileId),
      localCollections(profileId),
    ]);
    return {
      ratings,
      collections: {
        favorites: collections.favorites.map((item) => item.mal_id),
        hidden: collections.hidden.map((item) => item.mal_id),
      },
    };
  }
  const [ratings, collections] = await Promise.all([
    loadLibrary(profileId),
    loadCollections(profileId),
  ]);
  return {
    ratings,
    collections: {
      favorites: collections.favorites.map((item) => item.mal_id),
      hidden: collections.hidden.map((item) => item.mal_id),
    },
  };
}

export async function restoreProfileCollections(
  profileId: number,
  collections: ProfileCollectionIds,
) {
  if (browserModelEnabled) {
    return saveLocalCollections(profileId, collections);
  }
  throw new Error("当前版本无法导入想看和不感兴趣记录");
}

export async function removeCollectionItem(
  profileId: number,
  collection: keyof ProfileCollections,
  malId: number,
): Promise<void> {
  if (browserModelEnabled) return removeLocalCollection(profileId, collection, malId);
  const response = await fetch(
    `${API_BASE}/profiles/${profileId}/collections/${collection}/${malId}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function saveRatings(
  profileId: number,
  items: RatingItem[],
  externalItems: ExternalRatingItem[] = [],
): Promise<void> {
  if (browserModelEnabled) return saveLocalRatings(profileId, items, externalItems);
  await requestJson(`/profiles/${profileId}/ratings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, external_items: externalItems }),
  });
}

export async function importAniList(
  profileId: number,
  username: string,
): Promise<ImportPreview> {
  if (browserModelEnabled) return importAniListInBrowser(username);
  return requestJson<ImportPreview>("/profiles/import/anilist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: profileId, username }),
  });
}

export async function importBangumi(
  profileId: number,
  username: string,
  accessToken?: string,
): Promise<ImportPreview> {
  if (browserModelEnabled) return importBangumiInBrowser(username, accessToken);
  return requestJson<ImportPreview>("/profiles/import/bangumi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile_id: profileId,
      username,
      access_token: accessToken || null,
    }),
  });
}

export async function importMal(
  profileId: number,
  file: File,
): Promise<ImportPreview> {
  if (browserModelEnabled) return importMalInBrowser(file);
  const body = new FormData();
  body.set("profile_id", String(profileId));
  body.set("file", file);
  return requestJson<ImportPreview>("/profiles/import/mal", {
    method: "POST",
    body,
  });
}

export async function searchAnime(
  query: string,
  limit = 20,
): Promise<{ items: Anime[]; total: number }> {
  if (browserModelEnabled) return searchBrowserCatalog(query, limit);
  return requestJson<{ items: Anime[]; total: number }>(
    `/anime/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

export async function loadAnime(malId: number): Promise<Anime> {
  if (browserModelEnabled) return loadBrowserAnime(malId);
  return requestJson<Anime>(`/anime/${malId}`);
}

export async function loadRecommendationRun(
  runId: number,
): Promise<RecommendationRun> {
  if (browserModelEnabled) {
    const run = await loadLocalRun(runId);
    if (!run) throw new Error("推荐记录不存在");
    return {
      ...run,
      items: enrichBrowserRecommendations(run.items),
    };
  }
  return requestJson<RecommendationRun>(`/recommendations/${runId}`);
}

export async function loadRecommendationHistory(
  profileId: number,
): Promise<RecommendationHistoryItem[]> {
  if (browserModelEnabled) return localRunHistory(profileId);
  const payload = await requestJson<{ items: RecommendationHistoryItem[] }>(
    `/recommendations/history?profile_id=${profileId}`,
  );
  return payload.items;
}

export async function deleteRecommendationRun(runId: number): Promise<void> {
  if (browserModelEnabled) return deleteLocalRun(runId);
  const response = await fetch(`${API_BASE}/recommendations/${runId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function loadRecommendations(
  profileId = 1,
  filters: RecommendationFilters = {},
): Promise<RecommendationPayload> {
  const requestFilters = recommendationFilterRecord(filters);
  if (browserModelEnabled) {
    const [ratings, excluded, negativeItems, status] = await Promise.all([
      localRatingsMap(profileId),
      localExcluded(profileId),
      localNegativeItems(profileId),
      browserModelStatus(),
    ]);
    if (!status.manifest) throw new Error("模型尚未下载");
    const result = await recommendInBrowser({
      ratings,
      excluded,
      negativeItems,
      limit: requestFilters.limit,
      minSupport: requestFilters.min_support,
      allowSequels: requestFilters.allow_sequels,
      formats: requestFilters.formats,
      minimumBangumiScore: requestFilters.minimum_bangumi_score,
      minimumYear: requestFilters.minimum_year,
      maximumYear: requestFilters.maximum_year,
      includeShortForm: requestFilters.include_short_form,
      excludeRelated: requestFilters.exclude_related,
    });
    const run = await saveLocalRun(
      profileId,
      status.manifest.model_version,
      status.manifest.data_version,
      Object.keys(ratings).length >= 10 ? "ready" : "insufficient",
      result.items,
      requestFilters,
    );
    return {
      items: enrichBrowserRecommendations(run.items),
      runId: run.id,
      source: "api",
    };
  }
  const payload = await requestJson<{
    id: number;
    items: Recommendation[];
  }>("/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile_id: profileId,
      limit: requestFilters.limit,
      min_support: requestFilters.min_support,
      allow_sequels: requestFilters.allow_sequels,
      formats: requestFilters.formats,
    }),
  });
  return { items: payload.items, runId: payload.id, source: "api" };
}

export async function sendRecommendationFeedback(
  runId: number,
  malId: number,
  action: "favorite" | "hide",
) {
  if (browserModelEnabled) {
    const run = await loadLocalRun(runId);
    if (!run) throw new Error("推荐记录不存在");
    return setLocalCollection(
      run.profile_id,
      action === "favorite" ? "favorites" : "hidden",
      malId,
    );
  }
  const response = await fetch(
    `${API_BASE}/recommendations/${runId}/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mal_id: malId, action }),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
