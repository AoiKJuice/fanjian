import type {
  CollectionItem,
  ExternalLibraryItem,
  ExternalRatingItem,
  LibraryItem,
  Profile,
  ProfileCollections,
  RatingItem,
  RecommendationHistoryItem,
  RecommendationRun,
} from "./api";
import type { Anime, Recommendation } from "./data";

const DATABASE_NAME = "fanjian-local";
const DATABASE_VERSION = 1;

type StoredProfile = Profile & { created_at: string };
type StoredRating = RatingItem & { profile_id: number; updated_at: string };
type StoredExternalRating = ExternalRatingItem & {
  profile_id: number;
  updated_at: string;
};
type StoredCollection = {
  profile_id: number;
  kind: "favorites" | "hidden";
  mal_id: number;
  created_at: string;
};
type StoredRun = RecommendationRun & { filters: string };

let connection: Promise<IDBDatabase> | null = null;

function database() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error("本地数据库无法打开"));
      request.onupgradeneeded = () => {
        const db = request.result;
        const profiles = db.createObjectStore("profiles", {
          keyPath: "id",
          autoIncrement: true,
        });
        profiles.createIndex("updated_at", "updated_at");

        const ratings = db.createObjectStore("ratings", {
          keyPath: ["profile_id", "mal_id"],
        });
        ratings.createIndex("profile_id", "profile_id");

        const external = db.createObjectStore("external_ratings", {
          keyPath: ["profile_id", "source", "external_id"],
        });
        external.createIndex("profile_id", "profile_id");

        const collections = db.createObjectStore("collections", {
          keyPath: ["profile_id", "kind", "mal_id"],
        });
        collections.createIndex("profile_kind", ["profile_id", "kind"]);

        const runs = db.createObjectStore("recommendation_runs", {
          keyPath: "id",
          autoIncrement: true,
        });
        runs.createIndex("profile_id", "profile_id");
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
  return connection;
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地数据操作失败"));
  });
}

async function transaction(
  stores: string | string[],
  mode: IDBTransactionMode,
) {
  return (await database()).transaction(stores, mode);
}

function completed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("本地数据写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("本地数据写入已取消"));
  });
}

function now() {
  return new Date().toISOString();
}

async function ratingsForProfile(profileId: number) {
  const tx = await transaction("ratings", "readonly");
  return result(
    tx.objectStore("ratings").index("profile_id").getAll(profileId),
  ) as Promise<StoredRating[]>;
}

async function ensureProfile() {
  const profiles = await listLocalProfiles(false);
  if (profiles.length) return;
  await createLocalProfile("本地资料", "zh");
}

export async function listLocalProfiles(createDefault = true): Promise<Profile[]> {
  const tx = await transaction("profiles", "readonly");
  const profiles = await result(tx.objectStore("profiles").getAll()) as StoredProfile[];
  if (!profiles.length && createDefault) {
    await ensureProfile();
    return listLocalProfiles(false);
  }
  const output = await Promise.all(profiles.map(async (profile) => ({
    ...profile,
    rating_count: (await ratingsForProfile(profile.id)).filter(
      (item) => item.rating != null && item.status !== "plan_to_watch",
    ).length,
  })));
  return output.sort((left, right) => left.id - right.id);
}

export async function createLocalProfile(
  name: string,
  titleLanguage: "zh" | "native" | "en",
) {
  const created = now();
  const tx = await transaction("profiles", "readwrite");
  const request = tx.objectStore("profiles").add({
    name,
    title_language: titleLanguage,
    created_at: created,
    updated_at: created,
    rating_count: 0,
  });
  const id = Number(await result(request));
  await completed(tx);
  return {
    id,
    name,
    title_language: titleLanguage,
    created_at: created,
    updated_at: created,
    rating_count: 0,
  } as Profile;
}

export async function deleteLocalProfile(profileId: number) {
  const tx = await transaction(
    ["profiles", "ratings", "external_ratings", "collections", "recommendation_runs"],
    "readwrite",
  );
  tx.objectStore("profiles").delete(profileId);
  for (const name of ["ratings", "external_ratings", "recommendation_runs"]) {
    const store = tx.objectStore(name);
    const index = store.index("profile_id");
    const request = index.openKeyCursor(IDBKeyRange.only(profileId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  for (const kind of ["favorites", "hidden"] as const) {
    const store = tx.objectStore("collections");
    const request = store.index("profile_kind").openKeyCursor(
      IDBKeyRange.only([profileId, kind]),
    );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await completed(tx);
}

export async function saveLocalRatings(
  profileId: number,
  items: RatingItem[],
  externalItems: ExternalRatingItem[],
) {
  const updated = now();
  const tx = await transaction(
    ["profiles", "ratings", "external_ratings"],
    "readwrite",
  );
  const ratings = tx.objectStore("ratings");
  for (const item of items) {
    ratings.put({
      ...item,
      rating: item.status === "plan_to_watch" ? null : item.rating,
      profile_id: profileId,
      updated_at: updated,
    });
  }
  const external = tx.objectStore("external_ratings");
  for (const item of externalItems) {
    external.put({
      ...item,
      rating: item.status === "plan_to_watch" ? null : item.rating,
      profile_id: profileId,
      updated_at: updated,
    });
  }
  const profileStore = tx.objectStore("profiles");
  const profile = await result(profileStore.get(profileId)) as StoredProfile | undefined;
  if (!profile) throw new Error("本地资料不存在");
  profileStore.put({ ...profile, updated_at: updated });
  await completed(tx);
}

export async function loadLocalLibrary(profileId: number) {
  return ratingsForProfile(profileId);
}

export async function loadLocalExternalLibrary(profileId: number) {
  const tx = await transaction("external_ratings", "readonly");
  return result(
    tx.objectStore("external_ratings").index("profile_id").getAll(profileId),
  ) as Promise<StoredExternalRating[]>;
}

export async function associateLocalExternalRating(
  profileId: number,
  item: Pick<ExternalLibraryItem, "source" | "external_id">,
  malId: number,
) {
  const tx = await transaction(["ratings", "external_ratings"], "readwrite");
  const externalStore = tx.objectStore("external_ratings");
  const key = [profileId, item.source, item.external_id];
  const external = await result(externalStore.get(key)) as StoredExternalRating | undefined;
  if (!external) throw new Error("待关联项目不存在");
  tx.objectStore("ratings").put({
    profile_id: profileId,
    mal_id: malId,
    rating: external.status === "plan_to_watch" ? null : external.rating,
    status: external.status,
    updated_at: now(),
  });
  externalStore.delete(key);
  await completed(tx);
}

export async function localCollections(profileId: number) {
  const output: Record<"favorites" | "hidden", StoredCollection[]> = {
    favorites: [],
    hidden: [],
  };
  const tx = await transaction("collections", "readonly");
  for (const kind of ["favorites", "hidden"] as const) {
    output[kind] = await result(
      tx.objectStore("collections").index("profile_kind").getAll([profileId, kind]),
    ) as StoredCollection[];
  }
  return output;
}

export async function setLocalCollection(
  profileId: number,
  kind: "favorites" | "hidden",
  malId: number,
) {
  const tx = await transaction("collections", "readwrite");
  const store = tx.objectStore("collections");
  const other = kind === "favorites" ? "hidden" : "favorites";
  store.delete([profileId, other, malId]);
  store.put({ profile_id: profileId, kind, mal_id: malId, created_at: now() });
  await completed(tx);
}

export async function saveLocalCollections(
  profileId: number,
  collections: Record<"favorites" | "hidden", number[]>,
) {
  const tx = await transaction("collections", "readwrite");
  const store = tx.objectStore("collections");
  for (const kind of ["favorites", "hidden"] as const) {
    const other = kind === "favorites" ? "hidden" : "favorites";
    for (const malId of collections[kind]) {
      store.delete([profileId, other, malId]);
      store.put({ profile_id: profileId, kind, mal_id: malId, created_at: now() });
    }
  }
  await completed(tx);
}

export async function removeLocalCollection(
  profileId: number,
  kind: "favorites" | "hidden",
  malId: number,
) {
  const tx = await transaction("collections", "readwrite");
  tx.objectStore("collections").delete([profileId, kind, malId]);
  await completed(tx);
}

export async function saveLocalRun(
  profileId: number,
  modelVersion: string,
  dataVersion: string,
  status: "ready" | "insufficient",
  items: Recommendation[],
  filters: object,
  hasMore = false,
) {
  const created = now();
  const tx = await transaction("recommendation_runs", "readwrite");
  const request = tx.objectStore("recommendation_runs").add({
    profile_id: profileId,
    created_at: created,
    model_version: modelVersion,
    data_version: dataVersion,
    status,
    items,
    filters: JSON.stringify(filters),
    has_more: hasMore,
  });
  const id = Number(await result(request));
  await completed(tx);
  return {
    id,
    profile_id: profileId,
    created_at: created,
    model_version: modelVersion,
    data_version: dataVersion,
    status,
    items,
    filters: JSON.stringify(filters),
    has_more: hasMore,
  } as RecommendationRun;
}

export async function loadLocalRun(runId: number) {
  const tx = await transaction("recommendation_runs", "readonly");
  return result(tx.objectStore("recommendation_runs").get(runId)) as Promise<StoredRun | undefined>;
}

export async function updateLocalRun(
  runId: number,
  items: Recommendation[],
  filters: object,
  hasMore: boolean,
) {
  const stored = await loadLocalRun(runId);
  if (!stored) throw new Error("推荐记录不存在");
  const updated = {
    ...stored,
    items,
    filters: JSON.stringify(filters),
    has_more: hasMore,
  };
  const tx = await transaction("recommendation_runs", "readwrite");
  tx.objectStore("recommendation_runs").put(updated);
  await completed(tx);
  return updated as RecommendationRun;
}

export async function localRunHistory(profileId: number) {
  const tx = await transaction("recommendation_runs", "readonly");
  const runs = await result(
    tx.objectStore("recommendation_runs").index("profile_id").getAll(profileId),
  ) as StoredRun[];
  return runs
    .sort((left, right) => right.id - left.id)
    .map((run) => ({
      id: run.id,
      profile_id: run.profile_id,
      created_at: run.created_at,
      model_version: run.model_version,
      data_version: run.data_version,
      filters: run.filters,
      status: run.status,
      item_count: run.items.length,
    })) satisfies RecommendationHistoryItem[];
}

export async function deleteLocalRun(runId: number) {
  const tx = await transaction("recommendation_runs", "readwrite");
  tx.objectStore("recommendation_runs").delete(runId);
  await completed(tx);
}

export async function localRatingsMap(profileId: number) {
  return Object.fromEntries(
    (await ratingsForProfile(profileId))
      .filter((item) => item.rating != null && item.status !== "plan_to_watch")
      .map((item) => [item.mal_id, item.rating!]),
  );
}

export async function localExcluded(profileId: number) {
  const [ratings, collections] = await Promise.all([
    ratingsForProfile(profileId),
    localCollections(profileId),
  ]);
  return [...new Set([
    ...ratings.map((item) => item.mal_id),
    ...collections.hidden.map((item) => item.mal_id),
  ])];
}

export async function localNegativeItems(profileId: number) {
  return (await localCollections(profileId)).hidden.map((item) => item.mal_id);
}

export function enrichLibrary(
  rows: StoredRating[],
  anime: Map<number, Anime>,
  collections: Record<"favorites" | "hidden", StoredCollection[]>,
) {
  const favorites = new Set(collections.favorites.map((item) => item.mal_id));
  const hidden = new Set(collections.hidden.map((item) => item.mal_id));
  return rows.map((row) => ({
    mal_id: row.mal_id,
    rating: row.rating,
    status: row.status,
    updated_at: row.updated_at,
    anime: anime.get(row.mal_id) ?? null,
    favorite: Number(favorites.has(row.mal_id)),
    hidden: Number(hidden.has(row.mal_id)),
  })) satisfies LibraryItem[];
}

export function enrichCollections(
  rows: Record<"favorites" | "hidden", StoredCollection[]>,
  anime: Map<number, Anime>,
) {
  return Object.fromEntries(
    (["favorites", "hidden"] as const).map((kind) => [
      kind,
      rows[kind].map((row) => ({
        mal_id: row.mal_id,
        created_at: row.created_at,
        anime: anime.get(row.mal_id) ?? null,
      })) satisfies CollectionItem[],
    ]),
  ) as ProfileCollections;
}
