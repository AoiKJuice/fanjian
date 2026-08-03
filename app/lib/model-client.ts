"use client";

import { browserModelBaseUrl } from "./browser-mode";
import type {
  ModelDownloadProgress,
  ModelRecommendationRequest,
  ModelRecommendationResult,
  ModelStatus,
  ModelWorkerRequest,
  ModelWorkerResponse,
} from "./model-types";
import type { Anime } from "./data";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: ModelDownloadProgress) => void;
};

type ModelWorkerRequestWithoutId = ModelWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, PendingRequest>();

function manifestUrl() {
  return `${browserModelBaseUrl}/browser-model-manifest.json`;
}

function modelWorker() {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/model.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.addEventListener("message", (event: MessageEvent<ModelWorkerResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      if (!request) return;
      if (response.type === "progress") {
        request.onProgress?.(response.value);
        return;
      }
      pending.delete(response.id);
      if (response.type === "error") {
        request.reject(new Error(response.error));
      } else {
        request.resolve(response.value);
      }
    });
  }
  return worker;
}

function call<T>(
  request: ModelWorkerRequestWithoutId,
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<T> {
  const id = ++requestId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      onProgress,
    });
    modelWorker().postMessage({ ...request, id });
  });
}

export function browserModelStatus() {
  return call<ModelStatus>({
    type: "status",
    manifestUrl: manifestUrl(),
  });
}

export function downloadBrowserModel(
  onProgress: (progress: ModelDownloadProgress) => void,
) {
  return call<ModelStatus>(
    { type: "download", manifestUrl: manifestUrl() },
    onProgress,
  );
}

export function deleteBrowserModel() {
  return call<void>({ type: "delete" });
}

export function searchBrowserCatalog(query: string, limit: number, offset = 0) {
  return call<{ items: Anime[]; total: number }>({
    type: "search",
    query,
    limit,
    offset,
  });
}

export function loadBrowserAnime(malId: number) {
  return call<Anime>({ type: "anime", malId });
}

export function loadBrowserAnimeMany(malIds: number[]) {
  return call<Anime[]>({ type: "animeMany", malIds });
}

export function recommendInBrowser(payload: ModelRecommendationRequest) {
  return call<ModelRecommendationResult>({ type: "recommend", payload });
}

export function browserNeighborStats(
  ratings: Record<number, number>,
  negativeItems: number[],
) {
  return call<{
    neighborCount: number;
    meanOverlap: number;
    mainstreamIndex: number;
    longTailRatio: number;
  }>({
    type: "neighborStats",
    ratings,
    negativeItems,
  });
}
