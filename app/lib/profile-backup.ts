import type {
  ImportPreview,
  LibraryItem,
  Profile,
  RatingItem,
  WatchStatus,
} from "./api";

const WATCH_STATUSES = new Set<WatchStatus>([
  "completed",
  "watching",
  "dropped",
  "on_hold",
  "plan_to_watch",
]);

type TitleLanguage = "zh" | "native" | "en";

export type ProfileBackupCollections = {
  favorites: number[];
  hidden: number[];
};

export type ProfileBackupImport = {
  name: string;
  titleLanguage: TitleLanguage;
  preview: ImportPreview;
  collections: ProfileBackupCollections;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeProfileBackup(
  profile: Profile,
  items: Array<Pick<LibraryItem, "mal_id" | "rating" | "status" | "updated_at">>,
  collections: ProfileBackupCollections = { favorites: [], hidden: [] },
) {
  return JSON.stringify(
    {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      profile,
      ratings: items.map(({ mal_id, rating, status, updated_at }) => ({
        mal_id,
        rating,
        status,
        updated_at,
      })),
      collections,
    },
    null,
    2,
  );
}

export function parseProfileBackup(text: string): ProfileBackupImport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("无法读取这个 JSON 文件");
  }
  if (!isRecord(value) || !isRecord(value.profile) || !Array.isArray(value.ratings)) {
    throw new Error("这不是番鉴导出的资料文件");
  }

  const rawName = value.profile.name;
  const name = typeof rawName === "string" && rawName.trim()
    ? rawName.trim()
    : "我的资料";
  const rawLanguage = value.profile.title_language;
  const titleLanguage: TitleLanguage = rawLanguage === "native" || rawLanguage === "en"
    ? rawLanguage
    : "zh";

  const ratings = new Map<number, RatingItem>();
  let duplicates = 0;
  let invalid = 0;
  for (const row of value.ratings) {
    if (!isRecord(row)) {
      invalid += 1;
      continue;
    }
    const malId = row.mal_id;
    const rating = row.rating;
    const status = row.status;
    if (
      typeof malId !== "number" ||
      !Number.isInteger(malId) ||
      malId <= 0 ||
      !(rating === null || (
        typeof rating === "number" &&
        Number.isFinite(rating) &&
        rating >= 1 &&
        rating <= 10
      )) ||
      typeof status !== "string" ||
      !WATCH_STATUSES.has(status as WatchStatus)
    ) {
      invalid += 1;
      continue;
    }
    if (ratings.has(malId)) duplicates += 1;
    ratings.set(malId, {
      mal_id: malId,
      rating,
      status: status as WatchStatus,
    });
  }

  const items = [...ratings.values()];
  const rawCollections = isRecord(value.collections) ? value.collections : {};
  const collectionIds = (input: unknown) => Array.isArray(input)
    ? [...new Set(input.flatMap((item) => {
        const malId = typeof item === "number"
          ? item
          : isRecord(item) ? item.mal_id : null;
        return typeof malId === "number" && Number.isInteger(malId) && malId > 0
          ? [malId]
          : [];
      }))]
    : [];
  return {
    name,
    titleLanguage,
    preview: {
      imported: items.length,
      unmapped: 0,
      duplicates,
      unrated: items.filter((item) => item.rating === null).length,
      items,
      unmapped_items: [],
      warnings: invalid ? [`已忽略 ${invalid} 条无效记录`] : [],
    },
    collections: {
      favorites: collectionIds(rawCollections.favorites),
      hidden: collectionIds(rawCollections.hidden),
    },
  };
}
