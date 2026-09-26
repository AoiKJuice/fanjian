"use client";

import { browserModelBaseUrl } from "./browser-mode";
import releases from "./model-releases.json";
import type {
  ModelDownloadProgress,
  ModelRecommendationRequest,
  ModelRecommendationResult,
  ModelStatus,
  ModelWorkerRequest,
  ModelWorkerResponse,
  ModelInventory,
  BrowserModelManifest,
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
const downloadListeners = new Set<() => void>();
let downloadSnapshot: ModelStatus | null = null;
let activeDownload: Promise<ModelStatus> | null = null;

function publishDownloadStatus(status: ModelStatus) {
  downloadSnapshot = status;
  downloadListeners.forEach((listener) => listener());
}

function manifestUrl() {
  return `${browserModelBaseUrl}/browser-model-manifest.json`;
}

function modelWorker() {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/model.worker.ts", import.meta.url),
      { type: "module" },
    );
    const current = worker;
    const failed = () => {
      current.terminate();
      if (worker === current) worker = null;
      for (const request of pending.values()) request.reject(new Error("模型进程已中断，请重试"));
      pending.clear();
    };
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
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

export async function browserModelStatus() {
  const status = await call<ModelStatus>({
    type: "status",
    manifestUrl: manifestUrl(),
  });
  if (!activeDownload && !["paused", "error"].includes(downloadSnapshot?.state ?? "")) publishDownloadStatus(status);
  return status;
}

export function downloadBrowserModel(
  onProgress?: (progress: ModelDownloadProgress) => void,
  version?: string,
) {
  if (activeDownload) return activeDownload;
  const manifest = (releases.find((release) => release.manifest.model_version === version) ?? releases[0]).manifest as BrowserModelManifest;
  publishDownloadStatus({
    state: "downloading",
    downloadedBytes: downloadSnapshot?.manifest?.model_version === manifest.model_version ? downloadSnapshot.downloadedBytes : 0,
    totalBytes: manifest.total_bytes,
    manifest,
    activeVersion: downloadSnapshot?.activeVersion,
  });
  const task = call<ModelStatus>(
    { type: "download", manifestUrl: manifestUrl(), version },
    (progress) => {
      publishDownloadStatus(progress);
      onProgress?.(progress);
    },
  );
  activeDownload = task;
  void task.then(
    (status) => publishDownloadStatus(status),
    (reason: Error) => publishDownloadStatus({
      state: "error",
      downloadedBytes: downloadSnapshot?.downloadedBytes ?? 0,
      totalBytes: downloadSnapshot?.totalBytes ?? 0,
      error: reason.message,
      manifest: downloadSnapshot?.manifest,
    }),
  ).finally(() => {
    if (activeDownload === task) activeDownload = null;
  });
  return task;
}

export function browserModelInventory() {
  return call<ModelInventory>({ type: "inventory" });
}
export async function pauseBrowserModel() {
  const status = await call<ModelStatus>({ type: "pause" });
  publishDownloadStatus(status);
  return status;
}
export async function cancelBrowserModel(version: string) {
  const status = await call<ModelStatus>({ type: "cancel", version });
  publishDownloadStatus(status);
  return status;
}
export async function activateBrowserModel(version: string) {
  const status = await call<ModelStatus>({ type: "activate", version });
  publishDownloadStatus(status);
  return status;
}
export async function removeBrowserModel(version: string) {
  await call<void>({ type: "remove", version });
  if (downloadSnapshot?.manifest?.model_version === version) {
    publishDownloadStatus(await call<ModelStatus>({ type: "status", manifestUrl: manifestUrl() }));
  }
  return browserModelInventory();
}

export function subscribeBrowserModelStatus(listener: () => void) {
  downloadListeners.add(listener);
  return () => downloadListeners.delete(listener);
}

export function browserModelStatusSnapshot() {
  return downloadSnapshot;
}

export function browserModelServerSnapshot() {
  return null;
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
