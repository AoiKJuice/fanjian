"use client";

import { useEffect, useMemo, useState } from "react";
import { bangumiSubjectByMal } from "./bangumi-map.generated";
import type { Anime } from "./data";

const CACHE_NAME = "fanjian-bangumi-v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;

type BangumiSubject = {
  summary?: string;
  rating?: { score?: number };
};

export type BangumiMetadata = {
  score: number | null;
  synopsis: string;
};

const requests = new Map<number, Promise<BangumiMetadata | null>>();
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

async function cachedSubject(subjectId: number): Promise<BangumiSubject> {
  const url = `https://api.bgm.tv/v0/subjects/${subjectId}`;
  const request = new Request(url, { headers: { Accept: "application/json" } });
  const cache = "caches" in globalThis ? await caches.open(CACHE_NAME) : null;
  const cached = await cache?.match(request);
  const cachedAt = Number(cached?.headers.get("x-fanjian-cached-at") ?? 0);
  if (cached && Date.now() - cachedAt < CACHE_MAX_AGE_MS) {
    return cached.json() as Promise<BangumiSubject>;
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
  return JSON.parse(text) as BangumiSubject;
}

export function loadBangumiMetadata(malId: number) {
  const subjectId = bangumiSubjectByMal.get(malId);
  if (!subjectId) return Promise.resolve(null);
  const existing = requests.get(subjectId);
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
  requests.set(subjectId, task);
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
  const metadata = result?.malId === malId ? result.metadata : null;
  return useMemo(
    () => anime ? mergeBangumiAnime(anime, metadata) : anime,
    [anime, metadata],
  );
}
