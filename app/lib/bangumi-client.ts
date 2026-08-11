"use client";

import { useEffect, useMemo, useState } from "react";
import { bangumiSubjectByMal } from "./bangumi-map.generated";
import type { Anime, Recommendation } from "./data";

const CACHE_NAME = "fanjian-bangumi-v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;
const SCORE_FILTER_BATCH_SIZE = 48;

type BangumiSubject = {
  summary?: string;
  rating?: { score?: number };
};

type LegacyCommunityItem = {
  id?: number;
  title?: string;
  summary?: string;
  replies?: number;
  timestamp?: number;
  user?: { nickname?: string; username?: string };
};

type LegacySubject = {
  topic?: LegacyCommunityItem[];
  blog?: LegacyCommunityItem[];
};

type LegacyScoreSubject = {
  rating?: { score?: number };
};

export type BangumiMetadata = {
  score: number | null;
  synopsis: string;
};

export type BangumiCommunityEntry = {
  id: number;
  kind: "讨论" | "长评";
  title: string;
  summary: string;
  author: string;
  replies: number;
  timestamp: number;
  url: string;
};

export type BangumiCommunity = {
  subjectId: number;
  entries: BangumiCommunityEntry[];
};

const metadataRequests = new Map<number, Promise<BangumiMetadata | null>>();
const scoreRequests = new Map<number, Promise<number | null>>();
const communityRequests = new Map<number, Promise<BangumiCommunity | null>>();
const queue: Array<() => void> = [];
let activeRequests = 0;

function schedule<T>(task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeRequests += 1;
      void task().then(resolve, reject).finally(() => {
        activeRequests -= 1;
        queue.shift()?.();
      });
    };
    if (activeRequests < MAX_CONCURRENT_REQUESTS) start();
    else queue.push(start);
  });
}

async function cachedJson<T>(url: string): Promise<T> {
  const request = new Request(url, { headers: { Accept: "application/json" } });
  const cache = "caches" in globalThis ? await caches.open(CACHE_NAME) : null;
  const cached = await cache?.match(request);
  const cachedAt = Number(cached?.headers.get("x-fanjian-cached-at") ?? 0);
  if (cached && Date.now() - cachedAt < CACHE_MAX_AGE_MS) {
    return cached.json() as Promise<T>;
  }

  const response = await fetch(request);
  if (!response.ok) throw new Error(`Bangumi 返回 HTTP ${response.status}`);
  const text = await response.text();
  if (cache) {
    await cache.put(request, new Response(text, {
      headers: {
        "Content-Type": "application/json",
        "x-fanjian-cached-at": String(Date.now()),
      },
    }));
  }
  return JSON.parse(text) as T;
}

async function cachedSubject(subjectId: number): Promise<BangumiSubject> {
  return cachedJson<BangumiSubject>(
    `https://api.bgm.tv/v0/subjects/${subjectId}`,
  );
}

export function bangumiSubjectId(malId: number) {
  return bangumiSubjectByMal.get(malId) ?? null;
}

export function loadBangumiMetadata(malId: number) {
  const subjectId = bangumiSubjectByMal.get(malId);
  if (!subjectId) return Promise.resolve(null);
  const existing = metadataRequests.get(subjectId);
  if (existing) return existing;
  const task = schedule(async () => {
    try {
      const subject = await cachedSubject(subjectId);
      const score = Number(subject.rating?.score);
      return {
        score: Number.isFinite(score) && score > 0 ? score : null,
        synopsis: subject.summary?.trim() ?? "",
      };
    } catch {
      return null;
    }
  });
  metadataRequests.set(subjectId, task);
  return task;
}

export async function loadBangumiMetadataMany(malIds: number[]) {
  const pairs = await Promise.all(
    [...new Set(malIds)].map(async (malId) => [
      malId,
      await loadBangumiMetadata(malId),
    ] as const),
  );
  return new Map(pairs);
}

export function loadBangumiScore(malId: number) {
  const subjectId = bangumiSubjectByMal.get(malId);
  if (!subjectId) return Promise.resolve(null);
  const existing = scoreRequests.get(subjectId);
  if (existing) return existing;
  const task = schedule(async () => {
    try {
      const subject = await cachedJson<LegacyScoreSubject>(
        `https://api.bgm.tv/subject/${subjectId}?responseGroup=small`,
      );
      const score = Number(subject.rating?.score);
      return Number.isFinite(score) && score > 0 ? score : null;
    } catch {
      return null;
    }
  });
  scoreRequests.set(subjectId, task);
  return task;
}

export async function filterRecommendationsByBangumiScore(
  recommendations: Recommendation[],
  minimumScore: number,
  limit = 100,
) {
  const accepted: Recommendation[] = [];
  for (let offset = 0; offset < recommendations.length; offset += SCORE_FILTER_BATCH_SIZE) {
    const batch = recommendations
      .slice(offset, offset + SCORE_FILTER_BATCH_SIZE)
      .filter((item) => bangumiSubjectByMal.has(item.anime.mal_id));
    const scores = await Promise.all(
      batch.map((item) => loadBangumiScore(item.anime.mal_id)),
    );
    for (let index = 0; index < batch.length; index++) {
      const score = scores[index];
      if (score == null || score < minimumScore) continue;
      accepted.push({
        ...batch[index],
        anime: { ...batch[index].anime, bangumi_score: score },
      });
      if (accepted.length >= limit) return accepted;
    }
  }
  return accepted;
}

function communityEntry(
  item: LegacyCommunityItem,
  kind: "讨论" | "长评",
): BangumiCommunityEntry | null {
  const id = Number(item.id);
  const title = item.title?.trim();
  if (!Number.isFinite(id) || !title) return null;
  return {
    id,
    kind,
    title,
    summary: item.summary?.trim() ?? "",
    author: item.user?.nickname?.trim() || item.user?.username?.trim() || "Bangumi 用户",
    replies: Number(item.replies) || 0,
    timestamp: Number(item.timestamp) || 0,
    url: kind === "讨论"
      ? `https://bgm.tv/subject/topic/${id}`
      : `https://bgm.tv/blog/${id}`,
  };
}

export function loadBangumiCommunity(malId: number) {
  const subjectId = bangumiSubjectByMal.get(malId);
  if (!subjectId) return Promise.resolve(null);
  const existing = communityRequests.get(subjectId);
  if (existing) return existing;
  const task = schedule(async () => {
    try {
      const subject = await cachedJson<LegacySubject>(
        `https://api.bgm.tv/subject/${subjectId}?responseGroup=large`,
      );
      const entries = [
        ...(subject.topic ?? []).map((item) => communityEntry(item, "讨论")),
        ...(subject.blog ?? []).map((item) => communityEntry(item, "长评")),
      ].filter((item): item is BangumiCommunityEntry => item !== null)
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, 8);
      return { subjectId, entries };
    } catch {
      return null;
    }
  });
  communityRequests.set(subjectId, task);
  return task;
}

export function mergeBangumiAnime(
  anime: Anime,
  metadata: BangumiMetadata | null,
): Anime {
  if (!metadata) return anime;
  return {
    ...anime,
    bangumi_score: metadata.score ?? anime.bangumi_score,
    synopsis: metadata.synopsis || anime.synopsis,
  };
}

export function useBangumiAnime(anime: Anime | null | undefined) {
  const malId = anime?.mal_id;
  const [result, setResult] = useState<{
    malId: number;
    metadata: BangumiMetadata | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (malId) {
      void loadBangumiMetadata(malId).then((metadata) => {
        if (active) setResult({ malId, metadata });
      });
    }
    return () => {
      active = false;
    };
  }, [malId]);
  const metadata = result && result.malId === malId ? result.metadata : null;
  return useMemo(
    () => anime ? mergeBangumiAnime(anime, metadata) : anime,
    [anime, metadata],
  );
}
