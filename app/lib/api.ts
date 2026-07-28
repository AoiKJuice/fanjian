import type { Anime, Recommendation } from "./data";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export type RecommendationPayload = {
  items: Recommendation[];
  runId: number;
  source: "api";
};

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
  return requestJson<Profile[]>("/profiles");
}

export async function loadLocalHealth(): Promise<LocalHealth> {
  return requestJson<LocalHealth>("/health");
}

export async function loadInsights(profileId: number): Promise<Insights> {
  return requestJson<Insights>(`/profiles/${profileId}/insights`);
}

export async function loadModelCard(): Promise<ModelCard> {
  return requestJson<ModelCard>("/system/model-card");
}

export async function createProfile(
  name: string,
  titleLanguage: "zh" | "native" | "en",
): Promise<Profile> {
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
  const response = await fetch(`${API_BASE}/profiles/${profileId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function loadLibrary(profileId: number): Promise<LibraryItem[]> {
  const payload = await requestJson<{ items: LibraryItem[] }>(
    `/profiles/${profileId}/library`,
  );
  return payload.items;
}

export async function loadUnmappedLibrary(
  profileId: number,
): Promise<ExternalLibraryItem[]> {
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
  return requestJson<ProfileCollections>(
    `/profiles/${profileId}/collections`,
  );
}

export async function removeCollectionItem(
  profileId: number,
  collection: keyof ProfileCollections,
  malId: number,
): Promise<void> {
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
  return requestJson<{ items: Anime[]; total: number }>(
    `/anime/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

export async function loadAnime(malId: number): Promise<Anime> {
  return requestJson<Anime>(`/anime/${malId}`);
}

export async function loadRecommendationRun(
  runId: number,
): Promise<RecommendationRun> {
  return requestJson<RecommendationRun>(`/recommendations/${runId}`);
}

export async function loadRecommendationHistory(
  profileId: number,
): Promise<RecommendationHistoryItem[]> {
  const payload = await requestJson<{ items: RecommendationHistoryItem[] }>(
    `/recommendations/history?profile_id=${profileId}`,
  );
  return payload.items;
}

export async function deleteRecommendationRun(runId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/recommendations/${runId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function loadRecommendations(
  profileId = 1,
): Promise<RecommendationPayload> {
  const payload = await requestJson<{
    id: number;
    items: Recommendation[];
  }>("/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile_id: profileId,
      limit: 20,
      min_support: 5,
      allow_sequels: true,
      formats: [],
    }),
  });
  return { items: payload.items, runId: payload.id, source: "api" };
}

export async function sendRecommendationFeedback(
  runId: number,
  malId: number,
  action: "favorite" | "hide",
) {
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
