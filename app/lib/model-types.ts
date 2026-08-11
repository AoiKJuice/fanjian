import type { Anime, Recommendation } from "./data";

export type BrowserModelFile = {
  path: string;
  bytes: number;
  sha256: string;
  url: string;
};

export type BrowserModelManifest = {
  schema_version: 1;
  model_version: string;
  data_version: string;
  total_bytes: number;
  catalog_items: number;
  training_users: number;
  training_ratings: number;
  files: BrowserModelFile[];
  browser_catalog: BrowserModelFile;
};

export type BrowserCatalogItem = Anime & {
  anime_id: number;
  genres: string[];
  sequel: boolean;
};

export type ModelStatus = {
  state: "missing" | "downloading" | "ready" | "error";
  downloadedBytes: number;
  totalBytes: number;
  currentFile?: string;
  error?: string;
  manifest?: BrowserModelManifest;
};

export type ModelDownloadProgress = ModelStatus & {
  state: "downloading";
};

export type ModelRecommendationRequest = {
  ratings: Record<number, number>;
  excluded: number[];
  negativeItems: number[];
  offset?: number;
  limit: number;
  minimumAffinity?: number;
  minSupport: number;
  allowSequels: boolean;
  formats: string[];
  minimumBangumiScore?: number | null;
  minimumYear?: number | null;
  maximumYear?: number | null;
  includeShortForm?: boolean;
  excludeRelated?: boolean;
};

export type ModelRecommendationResult = {
  items: Recommendation[];
  neighborCount: number;
  meanOverlap: number;
  hasMore: boolean;
};

export type ModelWorkerRequest =
  | { id: number; type: "status"; manifestUrl: string }
  | { id: number; type: "download"; manifestUrl: string }
  | { id: number; type: "delete" }
  | { id: number; type: "search"; query: string; limit: number; offset: number }
  | { id: number; type: "anime"; malId: number }
  | { id: number; type: "animeMany"; malIds: number[] }
  | { id: number; type: "recommend"; payload: ModelRecommendationRequest }
  | { id: number; type: "neighborStats"; ratings: Record<number, number>; negativeItems: number[] };

export type ModelWorkerResponse =
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; error: string }
  | { id: number; type: "progress"; value: ModelDownloadProgress };
