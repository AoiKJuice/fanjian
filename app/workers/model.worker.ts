/// <reference lib="webworker" />

import type { Anime, Recommendation } from "../lib/data";
import {
  nonPrimaryAnimeIds,
  shortFormAnimeIds,
} from "../lib/anime-metadata.generated";
import { parseNpyShape } from "../lib/npy";
import type {
  BrowserCatalogItem,
  BrowserModelFile,
  BrowserModelManifest,
  ModelDownloadProgress,
  ModelRecommendationRequest,
  ModelRecommendationResult,
  ModelStatus,
  ModelWorkerRequest,
  ModelWorkerResponse,
} from "../lib/model-types";

const MODEL_DIRECTORY = "fanjian-model-v1";
const INSTALLED_FILE = "installed.json";
const CATALOG_FILE = ".catalog-installed.json";

const GENRE_LABELS: Record<string, string> = {
  action: "动作",
  adventure: "冒险",
  "avant garde": "先锋",
  "boys love": "耽美",
  comedy: "喜剧",
  "coming of age": "成长",
  crime: "犯罪",
  "dark fantasy": "黑暗奇幻",
  detective: "侦探",
  drama: "剧情",
  ecchi: "卖肉",
  "family life": "家庭",
  fantasy: "奇幻",
  friendship: "友情",
  game: "游戏",
  gourmet: "美食",
  idol: "偶像",
  isekai: "异世界",
  magic: "魔法",
  "magical girl": "魔法少女",
  "martial arts": "武术",
  mecha: "机甲",
  military: "军事",
  mythology: "神话",
  parody: "恶搞",
  "post-apocalyptic": "末世",
  romance: "恋爱",
  samurai: "武士",
  "sci-fi": "科幻",
  space: "太空",
  supernatural: "超自然",
  survival: "生存",
  suspense: "惊悚",
  "time travel": "时间旅行",
  "urban fantasy": "都市奇幻",
  vampire: "吸血鬼",
  school: "校园",
  "slice of life": "日常",
  "girls love": "百合",
  "cute girls doing cute things": "萌系日常",
  "female ensemble": "女性群像",
  iyashikei: "治愈",
  mystery: "悬疑",
  psychological: "心理",
  music: "音乐",
  sports: "运动",
  historical: "历史",
  horror: "恐怖",
};

const TAG_ALIASES: Record<string, string> = {
  "shounen ai": "boys love",
  "coming-of-age": "coming of age",
  detectives: "detective",
  games: "game",
  idols: "idol",
  "mahou shoujo": "magical girl",
  "post apocalyptic": "post-apocalyptic",
  "science fiction": "sci-fi",
  "sci fi": "sci-fi",
  "science-fiction": "sci-fi",
  "daily life": "slice of life",
  "school life": "school",
  "high school": "school",
  "shoujo ai": "girls love",
  yuri: "girls love",
  cgdct: "cute girls doing cute things",
  "primarily female cast": "female ensemble",
  "predominantly female cast": "female ensemble",
  thriller: "suspense",
  healing: "iyashikei",
  cooking: "gourmet",
  vampires: "vampire",
};

const TAG_SPECIFICITY: Record<string, number> = {
  action: 0.72,
  adventure: 0.78,
  comedy: 0.68,
  drama: 0.68,
  fantasy: 0.72,
  romance: 0.78,
  "sci-fi": 0.82,
  supernatural: 0.82,
  "cute girls doing cute things": 1.8,
  "female ensemble": 1.1,
  "girls love": 2,
  iyashikei: 1.7,
  "magical girl": 1.55,
  school: 0.9,
  "slice of life": 1.1,
};

type TypedArray =
  | Float32Array
  | Int32Array
  | BigInt64Array;

type Neighbor = {
  userIdx: number;
  similarity: number;
  overlap: number;
};

type RecommendationTarget = {
  items: number[];
  residuals: number[];
};

type RecommendationCandidate = {
  item: number;
  score: number;
  affinity: number;
  variance: number;
  effectiveSample: number;
};

type RecommendationCore = {
  key: string;
  target: RecommendationTarget;
  neighbors: Neighbor[];
  candidates: RecommendationCandidate[];
  support: Uint16Array;
  distribution: Uint16Array[];
  neighborTargetValues: Float32Array[];
  neighborSupport: Uint32Array;
  neighborWords: number;
  profileSeries: Set<string>;
  likedGenres: Map<string, number>;
  meanOverlap: number;
  materialized: Map<number, Recommendation>;
};

class Sha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private bytes = 0;

  update(input: Uint8Array) {
    this.bytes += input.length;
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(64 - this.buffered, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + count), this.buffered);
      this.buffered += count;
      offset += count;
      if (this.buffered === 64) {
        this.compress(this.buffer);
        this.buffered = 0;
      }
    }
  }

  digest() {
    const bitLength = this.bytes * 8;
    this.buffer[this.buffered++] = 0x80;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered);
      this.compress(this.buffer);
      this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.buffer);
    return Array.from(this.state)
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }

  private compress(block: Uint8Array) {
    const k = SHA256_CONSTANTS;
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + k[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, shift: number) {
  return (value >>> shift) | (value << (32 - shift));
}

async function modelDirectory(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MODEL_DIRECTORY, { create });
}

async function fileHandleForPath(
  directory: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
) {
  const parts = path.split("/").filter(Boolean);
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current.getFileHandle(parts.at(-1)!, { create });
}

async function readJson<T>(directory: FileSystemDirectoryHandle, path: string) {
  const handle = await fileHandleForPath(directory, path, false);
  return JSON.parse(await (await handle.getFile()).text()) as T;
}

async function writeJson(
  directory: FileSystemDirectoryHandle,
  path: string,
  value: unknown,
) {
  const handle = await fileHandleForPath(directory, path, true);
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

async function fetchManifest(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`模型清单读取失败：HTTP ${response.status}`);
  return (await response.json()) as BrowserModelManifest;
}

async function installedManifest() {
  try {
    return await readJson<BrowserModelManifest>(
      await modelDirectory(false),
      INSTALLED_FILE,
    );
  } catch {
    return null;
  }
}

async function catalogManifest() {
  try {
    return await readJson<BrowserModelManifest>(
      await modelDirectory(false),
      CATALOG_FILE,
    );
  } catch {
    return null;
  }
}

async function currentStatus(manifestUrl: string): Promise<ModelStatus> {
  const installed = await installedManifest();
  let manifest: BrowserModelManifest;
  try {
    manifest = await fetchManifest(manifestUrl);
  } catch (reason) {
    if (!installed) throw reason;
    manifest = installed;
  }
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await modelDirectory(false);
  } catch {
    return {
      state: "missing",
      downloadedBytes: 0,
      totalBytes: manifest.total_bytes,
      manifest,
    };
  }
  let downloadedBytes = 0;
  let complete = installed?.model_version === manifest.model_version;
  for (const record of [manifest.browser_catalog, ...manifest.files]) {
    try {
      const file = await (await fileHandleForPath(directory, record.path, false)).getFile();
      downloadedBytes += Math.min(file.size, record.bytes);
      if (file.size !== record.bytes) complete = false;
    } catch {
      complete = false;
    }
  }
  return {
    state: complete ? "ready" : "missing",
    downloadedBytes,
    totalBytes: manifest.total_bytes,
    manifest,
  };
}

async function sha256File(file: File) {
  const hash = new Sha256();
  const reader = file.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest();
}

async function downloadFile(
  directory: FileSystemDirectoryHandle,
  record: BrowserModelFile,
  downloadedBefore: number,
  totalBytes: number,
  report: (progress: ModelDownloadProgress) => void,
) {
  const handle = await fileHandleForPath(directory, record.path, true);
  let file = await handle.getFile();
  let offset = file.size <= record.bytes ? file.size : 0;
  const headers = offset ? { Range: `bytes=${offset}-` } : undefined;
  const response = await fetch(record.url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`${record.path} 下载失败：HTTP ${response.status}`);
  }
  if (offset && response.status !== 206) offset = 0;
  const writable = await handle.createWritable({ keepExistingData: offset > 0 });
  if (!offset) await writable.truncate(0);
  await writable.seek(offset);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${record.path} 没有下载数据`);
  let position = offset;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      position += value.byteLength;
      report({
        state: "downloading",
        downloadedBytes: downloadedBefore + position,
        totalBytes,
        currentFile: record.path,
      });
    }
  } catch (reason) {
    try {
      await writable.abort(reason);
    } catch {
      // The stream can already be errored by the failed write.
    }
    throw reason;
  }
  await writable.close();
  file = await handle.getFile();
  if (file.size !== record.bytes) {
    throw new Error(`${record.path} 文件大小不符`);
  }
  if ((await sha256File(file)) !== record.sha256.toLowerCase()) {
    throw new Error(`${record.path} 校验失败`);
  }
}

async function downloadModel(
  manifestUrl: string,
  report: (progress: ModelDownloadProgress) => void,
) {
  const manifest = await fetchManifest(manifestUrl);
  await navigator.storage.persist?.();
  const directory = await modelDirectory(true);
  const records = [manifest.browser_catalog, ...manifest.files];
  let completed = 0;
  for (const record of records) {
    const existing = await fileHandleForPath(directory, record.path, true).then(
      (handle) => handle.getFile(),
    );
    if (
      existing.size === record.bytes &&
      (await sha256File(existing)) === record.sha256.toLowerCase()
    ) {
      completed += record.bytes;
    } else {
      await downloadFile(directory, record, completed, manifest.total_bytes, report);
      completed += record.bytes;
    }
    if (record.path === manifest.browser_catalog.path) {
      await writeJson(directory, CATALOG_FILE, manifest);
      catalogRuntime = null;
    }
  }
  await writeJson(directory, INSTALLED_FILE, manifest);
  runtime = null;
  return currentStatus(manifestUrl);
}

class NpyReader {
  constructor(
    private file: File,
    readonly dtype: string,
    readonly length: number,
    private dataOffset: number,
  ) {}

  static async open(directory: FileSystemDirectoryHandle, path: string) {
    const handle = await fileHandleForPath(directory, path, false);
    const file = await handle.getFile();
    const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...prefix.slice(1, 6)) !== "NUMPY") {
      throw new Error(`${path} 不是 NPY 文件`);
    }
    const major = prefix[6];
    const headerLength = major === 1
      ? new DataView(prefix.buffer).getUint16(8, true)
      : new DataView(prefix.buffer).getUint32(8, true);
    const headerOffset = major === 1 ? 10 : 12;
    const header = new TextDecoder("latin1").decode(
      await file.slice(headerOffset, headerOffset + headerLength).arrayBuffer(),
    );
    const dtype = header.match(/'descr':\s*'([^']+)'/)?.[1];
    const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1];
    if (!dtype || shapeText == null) throw new Error(`${path} NPY 头无法解析`);
    const shape = parseNpyShape(shapeText);
    return new NpyReader(
      file,
      dtype,
      shape.reduce((product, value) => product * value, 1),
      headerOffset + headerLength,
    );
  }

  async read(start = 0, stop = this.length): Promise<TypedArray> {
    const bytes = this.dtype.endsWith("8") ? 8 : 4;
    const buffer = await this.file
      .slice(this.dataOffset + start * bytes, this.dataOffset + stop * bytes)
      .arrayBuffer();
    if (this.dtype.endsWith("f4")) return new Float32Array(buffer);
    if (this.dtype.endsWith("i4")) return new Int32Array(buffer);
    if (this.dtype.endsWith("i8")) return new BigInt64Array(buffer);
    throw new Error(`不支持的 NPY 类型：${this.dtype}`);
  }
}

function numberAt(values: TypedArray, index: number) {
  const value = values[index];
  return typeof value === "bigint" ? Number(value) : value;
}

class BrowserRecommender {
  private catalog: BrowserCatalogItem[] = [];
  private itemByMal = new Map<number, number>();
  private malIds!: Int32Array;
  private itemBias!: Float32Array;
  private itemCounts!: BigInt64Array;
  private itemIuf!: Float32Array;
  private itemSurprise!: Float32Array;
  private csrIndptr!: BigInt64Array;
  private cscIndptr!: BigInt64Array;
  private csrIndices!: NpyReader;
  private csrRatings!: NpyReader;
  private csrResiduals!: NpyReader;
  private cscIndices!: NpyReader;
  private cscResiduals!: NpyReader;
  private seriesKeys: string[] = [];
  private ancillary!: Uint8Array;
  private inferredContinuation!: Uint8Array;
  private requiresContext!: Uint8Array;
  private globalMean = 0;
  private userCount = 0;
  private neighborCache: {
    key: string;
    target: RecommendationTarget;
    neighbors: Neighbor[];
  } | null = null;
  private neighborBuild: Promise<void> | null = null;
  private recommendationCache: RecommendationCore | null = null;
  private recommendationBuild: Promise<void> | null = null;

  async initialize(manifest: BrowserModelManifest) {
    const directory = await modelDirectory(false);
    this.catalog = await readJson<BrowserCatalogItem[]>(
      directory,
      manifest.browser_catalog.path,
    );
    this.itemByMal = new Map(this.catalog.map((item, index) => [item.mal_id, index]));
    this.seriesKeys = this.catalog.map((item) => seriesKey(item.title_en));
    this.ancillary = Uint8Array.from(
      this.catalog.map((item) => Number(isAncillary(item.format, item.title_en))),
    );
    this.inferredContinuation = Uint8Array.from(
      this.catalog.map((item) => Number(looksLikeContinuation(item.title_en))),
    );
    this.requiresContext = Uint8Array.from(
      this.catalog.map((item) => Number(requiresSeriesContext(item.format, item.title_en))),
    );
    const open = (path: string) => NpyReader.open(directory, path);
    const [malIds, itemBias, itemCounts, itemIuf, itemSurprise, csrIndptr, cscIndptr] =
      await Promise.all([
        open("mal_ids.npy"), open("item_bias.npy"), open("item_counts.npy"),
        open("item_iuf.npy"), open("item_surprise.npy"), open("csr_indptr.npy"),
        open("csc_indptr.npy"),
      ]);
    this.malIds = (await malIds.read()) as Int32Array;
    this.itemBias = (await itemBias.read()) as Float32Array;
    this.itemCounts = (await itemCounts.read()) as BigInt64Array;
    this.itemIuf = (await itemIuf.read()) as Float32Array;
    this.itemSurprise = (await itemSurprise.read()) as Float32Array;
    this.csrIndptr = (await csrIndptr.read()) as BigInt64Array;
    this.cscIndptr = (await cscIndptr.read()) as BigInt64Array;
    [
      this.csrIndices,
      this.csrRatings,
      this.csrResiduals,
      this.cscIndices,
      this.cscResiduals,
    ] = await Promise.all([
      open("csr_indices.npy"),
      open("csr_ratings.npy"),
      open("csr_residuals.npy"),
      open("csc_indices.npy"),
      open("csc_residuals.npy"),
    ]);
    this.globalMean = Number(
      await (await fileHandleForPath(directory, "global_mean.txt", false)).getFile()
        .then((file) => file.text()),
    );
    this.userCount = manifest.training_users;
    this.neighborCache = null;
    this.neighborBuild = null;
    this.recommendationCache = null;
    this.recommendationBuild = null;
  }

  search(query: string, limit: number, offset: number) {
    const normalized = query.trim().toLocaleLowerCase();
    const numericId = /^\d+$/.test(normalized) ? Number(normalized) : null;
    const matches = this.catalog.filter((item) =>
      numericId === item.mal_id ||
      !normalized ||
      [item.title_zh, item.title_native, item.title_en]
        .some((title) => title?.toLocaleLowerCase().includes(normalized)),
    );
    return {
      items: matches.slice(offset, offset + limit).map(publicAnime),
      total: matches.length,
    };
  }

  anime(malId: number) {
    const index = this.itemByMal.get(malId);
    if (index == null) throw new Error("未找到这部番剧");
    return publicAnime(this.catalog[index]);
  }

  animeMany(malIds: number[]) {
    return malIds.flatMap((malId) => {
      const index = this.itemByMal.get(malId);
      return index == null ? [] : [publicAnime(this.catalog[index])];
    });
  }

  async neighborStats(ratings: Record<number, number>, negativeItems: number[]) {
    const { neighbors } = await this.neighborData(ratings, negativeItems);
    const catalogCounts = Array.from(this.itemCounts, Number)
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    const watchedCounts = Object.keys(ratings).flatMap((malId) => {
      const item = this.itemByMal.get(Number(malId));
      return item == null || numberAt(this.itemCounts, item) <= 0
        ? []
        : [numberAt(this.itemCounts, item)];
    });
    const longTailLimit = catalogCounts.length
      ? catalogCounts[Math.floor((catalogCounts.length - 1) * 0.33)]
      : 0;
    const percentiles = watchedCounts.map(
      (count) => upperBound(catalogCounts, count) / catalogCounts.length,
    );
    return {
      neighborCount: neighbors.length,
      meanOverlap: neighbors.length
        ? round(neighbors.reduce((sum, item) => sum + item.overlap, 0) / neighbors.length, 2)
        : 0,
      mainstreamIndex: percentiles.length ? round(sum(percentiles) / percentiles.length * 100, 1) : 0,
      longTailRatio: watchedCounts.length
        ? round(watchedCounts.filter((count) => count <= longTailLimit).length / watchedCounts.length * 100, 1)
        : 0,
    };
  }

  async recommend(payload: ModelRecommendationRequest): Promise<ModelRecommendationResult> {
    const core = await this.recommendationCoreFor(payload);
    const neighbors = core.neighbors;
    if (!neighbors.length) {
      return { items: [], neighborCount: 0, meanOverlap: 0, hasMore: false };
    }
    const excluded = new Set([
      ...payload.excluded,
      ...payload.negativeItems,
      ...Object.keys(payload.ratings).map(Number),
    ]);
    const formats = new Set(payload.formats.map((value) => value.toUpperCase()));
    const minimumAffinity = payload.minimumAffinity ?? 60;
    const offset = Math.max(0, payload.offset ?? 0);
    const limit = Math.max(1, payload.limit);
    const selected: RecommendationCandidate[] = [];
    const usedSeries = new Set<string>();
    for (const candidate of core.candidates) {
      const catalogItem = this.catalog[candidate.item];
      const malId = this.malIds[candidate.item];
      const rawBangumiScore = catalogItem.bangumi_score;
      const bangumiScore = Number(rawBangumiScore);
      const year = Number(catalogItem.year);
      if (
        candidate.affinity < minimumAffinity ||
        core.support[candidate.item] < payload.minSupport ||
        excluded.has(malId) ||
        (formats.size && !formats.has(catalogItem.format.toUpperCase())) ||
        (payload.minimumBangumiScore != null &&
          (rawBangumiScore == null || !Number.isFinite(bangumiScore) ||
            bangumiScore < payload.minimumBangumiScore)) ||
        (payload.minimumYear != null &&
          (!Number.isFinite(year) || year < payload.minimumYear)) ||
        (payload.maximumYear != null &&
          (!Number.isFinite(year) || year > payload.maximumYear)) ||
        (payload.includeShortForm === false && shortFormAnimeIds.has(malId))
      ) continue;
      if (payload.excludeRelated && (
        catalogItem.sequel ||
        this.inferredContinuation[candidate.item] ||
        this.requiresContext[candidate.item] ||
        this.ancillary[candidate.item] ||
        nonPrimaryAnimeIds.has(malId)
      )) continue;
      if (!payload.allowSequels) {
        if (catalogItem.sequel || this.inferredContinuation[candidate.item]) continue;
        if (this.requiresContext[candidate.item] &&
          !core.profileSeries.has(this.seriesKeys[candidate.item])) continue;
      }
      const series = this.seriesKeys[candidate.item];
      if (series && usedSeries.has(series)) continue;
      selected.push(candidate);
      if (series) usedSeries.add(series);
      if (selected.length > offset + limit) break;
    }
    const page = selected.slice(offset, offset + limit);
    const items = page.map((candidate) => this.materializeRecommendation(
      core,
      candidate,
      payload.ratings,
    ));
    return {
      items,
      neighborCount: neighbors.length,
      meanOverlap: core.meanOverlap,
      hasMore: selected.length > offset + limit,
    };
  }

  private recommendationInputKey(
    ratings: Record<number, number>,
    negativeItems: number[],
  ) {
    return JSON.stringify([
      Object.entries(ratings).sort((left, right) => Number(left[0]) - Number(right[0])),
      [...negativeItems].sort((left, right) => left - right),
    ]);
  }

  private async neighborData(
    ratings: Record<number, number>,
    negativeItems: number[],
  ) {
    const key = this.recommendationInputKey(ratings, negativeItems);
    if (this.neighborCache?.key === key) return this.neighborCache;
    while (this.neighborBuild) await this.neighborBuild;
    if (this.neighborCache?.key === key) return this.neighborCache;
    let releaseBuild = () => undefined;
    const build = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    this.neighborBuild = build;
    try {
      const target = this.target(ratings);
      const neighbors = await this.neighbors(ratings, new Set(negativeItems));
      this.neighborCache = { key, target, neighbors };
      return this.neighborCache;
    } finally {
      if (this.neighborBuild === build) this.neighborBuild = null;
      releaseBuild();
    }
  }

  private async recommendationCoreFor(
    payload: ModelRecommendationRequest,
  ): Promise<RecommendationCore> {
    const requestedKey = this.recommendationInputKey(
      payload.ratings,
      payload.negativeItems,
    );
    if (this.recommendationCache?.key === requestedKey) return this.recommendationCache;
    while (this.recommendationBuild) await this.recommendationBuild;
    if (this.recommendationCache?.key === requestedKey) return this.recommendationCache;
    let releaseBuild = () => undefined;
    const build = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    this.recommendationBuild = build;
    try {
      return await this.buildRecommendationCore(payload);
    } finally {
      if (this.recommendationBuild === build) this.recommendationBuild = null;
      releaseBuild();
    }
  }

  private async buildRecommendationCore(
    payload: ModelRecommendationRequest,
  ): Promise<RecommendationCore> {
    const { key, target, neighbors } = await this.neighborData(
      payload.ratings,
      payload.negativeItems,
    );
    const itemCount = this.malIds.length;
    const weightedSum = new Float64Array(itemCount);
    const weightSum = new Float64Array(itemCount);
    const weightedSquareSum = new Float64Array(itemCount);
    const squaredWeightSum = new Float64Array(itemCount);
    const weightedRawRatingSum = new Float64Array(itemCount);
    const support = new Uint16Array(itemCount);
    const distribution = Array.from({ length: 4 }, () => new Uint16Array(itemCount));
    const neighborTargetValues = Array.from(
      { length: neighbors.length },
      () => new Float32Array(target.items.length).fill(Number.NaN),
    );
    const neighborWords = Math.max(1, Math.ceil(neighbors.length / 32));
    const neighborSupport = new Uint32Array(itemCount * neighborWords);
    const targetPositions = new Map(target.items.map((item, index) => [item, index]));

    for (let neighborPosition = 0; neighborPosition < neighbors.length; neighborPosition++) {
      const neighbor = neighbors[neighborPosition];
      const start = Number(this.csrIndptr[neighbor.userIdx]);
      const stop = Number(this.csrIndptr[neighbor.userIdx + 1]);
      const [items, values, rawRatings] = await Promise.all([
        this.csrIndices.read(start, stop) as Promise<Int32Array>,
        this.csrResiduals.read(start, stop) as Promise<Float32Array>,
        this.csrRatings.read(start, stop) as Promise<Float32Array>,
      ]);
      for (let row = 0; row < items.length; row++) {
        const item = items[row];
        const value = clamp(values[row], -2, 2);
        const raw = rawRatings[row];
        const similarity = neighbor.similarity;
        weightedSum[item] += similarity * value;
        weightSum[item] += similarity;
        weightedSquareSum[item] += similarity * value * value;
        squaredWeightSum[item] += similarity * similarity;
        weightedRawRatingSum[item] += similarity * raw;
        support[item]++;
        distribution[raw <= 4 ? 0 : raw <= 6 ? 1 : raw <= 8 ? 2 : 3][item]++;
        neighborSupport[item * neighborWords + (neighborPosition >>> 5)] |=
          1 << (neighborPosition & 31);
        const targetPosition = targetPositions.get(item);
        if (targetPosition != null) neighborTargetValues[neighborPosition][targetPosition] = value;
      }
    }

    const profileSeries = new Set(target.items.map((item) => this.seriesKeys[item]));
    const candidates: RecommendationCandidate[] = [];
    for (let item = 0; item < itemCount; item++) {
      if (
        weightSum[item] <= 0 ||
        numberAt(this.itemCounts, item) < 20
      ) continue;
      const estimate = weightedSum[item] / weightSum[item];
      const variance = Math.max(weightedSquareSum[item] / weightSum[item] - estimate ** 2, 0);
      const effectiveSample = weightSum[item] ** 2 / Math.max(squaredWeightSum[item], 1e-12);
      if (effectiveSample < 3) continue;
      const reliability = effectiveSample / (effectiveSample + 10);
      const neighborMeanRating = weightedRawRatingSum[item] / weightSum[item];
      const absolutePreference = clamp((neighborMeanRating - 7.5) / 2.5, -1, 1);
      let score = estimate * reliability - 0.5 * Math.sqrt(variance / effectiveSample)
        + 0.75 * absolutePreference;
      if (this.ancillary[item]) score -= 0.45;
      candidates.push({
        item,
        score,
        affinity: clamp(Math.round(50 + 32 * Math.tanh(score)), 1, 95),
        variance,
        effectiveSample,
      });
    }
    candidates.sort((left, right) => right.score - left.score);
    this.recommendationCache = {
      key,
      target,
      neighbors,
      candidates,
      support,
      distribution,
      neighborTargetValues,
      neighborSupport,
      neighborWords,
      profileSeries,
      likedGenres: this.likedGenres(payload.ratings),
      meanOverlap: neighbors.length
        ? round(
            neighbors.reduce((sum, neighbor) => sum + neighbor.overlap, 0) /
              neighbors.length,
            2,
          )
        : 0,
      materialized: new Map(),
    };
    return this.recommendationCache;
  }

  private materializeRecommendation(
    core: RecommendationCore,
    candidate: RecommendationCandidate,
    ratings: Record<number, number>,
  ) {
    const cached = core.materialized.get(candidate.item);
    if (cached) return cached;
    const item = candidate.item;
    const supporting = core.neighbors.map((_, neighborPosition) => Boolean(
      core.neighborSupport[item * core.neighborWords + (neighborPosition >>> 5)] &
      (1 << (neighborPosition & 31)),
    ));
    const evidence = this.evidence(
      ratings,
      core.target,
      core.neighbors,
      core.neighborTargetValues,
      supporting,
    );
    const itemSupport = core.support[item];
    const anime = publicAnime(this.catalog[item]);
    anime.matched_tags = this.matchedTags(item, core.likedGenres);
    const recommendation: Recommendation = {
        anime,
        rank_score: round(candidate.score, 6),
        affinity: candidate.affinity,
        confidence:
          itemSupport >= 20 && candidate.effectiveSample >= 12 &&
          candidate.variance <= 0.8 && !this.ancillary[item]
            ? "高"
            : itemSupport >= 8 && candidate.effectiveSample >= 5 ? "中" : "低",
        support: itemSupport,
        effective_sample_size: round(candidate.effectiveSample, 2),
        reason: evidence[0]
          ? `${itemSupport} 名相似用户支持，其中与《${evidence[0].title}》的评价最能说明本次匹配。`
          : `${itemSupport} 名相似用户支持本次推荐。`,
        evidence,
        neighbor_distribution: {
          "1-4": core.distribution[0][item],
          "5-6": core.distribution[1][item],
          "7-8": core.distribution[2][item],
          "9-10": core.distribution[3][item],
        },
        risk: this.ancillary[item]
          ? "属于系列附属内容，已降低排序权重。"
          : candidate.variance > 0.8
            ? "相似用户意见分歧较大，亲和度可能波动。"
            : itemSupport < 10
              ? "支持样本较少，当前排序已进行收缩校正。"
              : "样本意见较集中，仍需结合观看时长判断。",
        relation_notice: this.catalog[item].sequel
          ? "该作品被标记为续作，请确认已完成前作。"
          : null,
    };
    core.materialized.set(item, recommendation);
    return recommendation;
  }

  private target(ratings: Record<number, number>) {
    const mapped = Object.entries(ratings)
      .map(([malId, rating]) => ({
        item: this.itemByMal.get(Number(malId)),
        rating: Math.fround(rating),
      }))
      .filter((entry): entry is { item: number; rating: number } =>
        entry.item != null && entry.rating >= 1 && entry.rating <= 10,
      );
    const values = mapped.map((entry) => entry.rating);
    const bias = (
      float32Sum(values) - values.length * this.globalMean
    ) / (values.length + 10);
    const raw = mapped.map(
      (entry) => Math.fround(
        Math.fround(Math.fround(entry.rating - this.globalMean) - bias)
        - this.itemBias[entry.item],
      ),
    );
    const mean = raw.length ? Math.fround(float32Sum(raw) / raw.length) : 0;
    const squared = raw.map((value) => {
      const difference = Math.fround(value - mean);
      return Math.fround(difference * difference);
    });
    const scale = Math.max(
      Math.fround(Math.sqrt(Math.fround(
        float32Sum(squared) / Math.max(raw.length, 1),
      ))),
      0.5,
    );
    return {
      items: mapped.map((entry) => entry.item),
      residuals: raw.map((value) => Math.fround(clamp(
        Math.fround(value / scale),
        -2,
        2,
      ))),
    };
  }

  private async neighbors(ratings: Record<number, number>, negativeItems: Set<number>) {
    const target = this.target(ratings);
    const items = [...target.items];
    const residuals = [...target.residuals];
    const explicit = new Set(items);
    for (const malId of [...negativeItems].sort((a, b) => a - b)) {
      const item = this.itemByMal.get(malId);
      if (item != null && !explicit.has(item)) {
        items.push(item);
        residuals.push(-1.25);
      }
    }
    if (items.length < 10) return [];
    const balances = seriesBalance(items.map((item) => this.seriesKeys[item]));
    const overlap = new Uint16Array(this.userCount);
    const numerator = new Float32Array(this.userCount);
    const targetNorm = new Float32Array(this.userCount);
    const neighborNorm = new Float32Array(this.userCount);
    for (let position = 0; position < items.length; position++) {
      const item = items[position];
      const targetValue = residuals[position];
      const start = Number(this.cscIndptr[item]);
      const stop = Number(this.cscIndptr[item + 1]);
      const [users, values] = await Promise.all([
        this.cscIndices.read(start, stop) as Promise<Int32Array>,
        this.cscResiduals.read(start, stop) as Promise<Float32Array>,
      ]);
      const targetBucket = bucket(targetValue);
      const targetWeight = targetValue >= 0.7 ? 2 : targetValue <= -0.7 ? 0.25 : 0.5;
      for (let row = 0; row < users.length; row++) {
        const user = users[row];
        const value = clamp(values[row], -2, 2);
        const surprise = Math.fround((
          this.itemSurprise[item * 3 + targetBucket] +
          this.itemSurprise[item * 3 + bucket(value)]
        ) * 0.5);
        const eventWeight = Math.fround(
          1 + Math.fround(0.75 * this.itemIuf[item])
          + Math.fround(0.25 * surprise),
        );
        const weight = Math.fround(
          eventWeight * Math.fround(balances[position] * targetWeight),
        );
        const weightedTarget = Math.fround(weight * targetValue);
        overlap[user]++;
        numerator[user] = Math.fround(
          numerator[user] + Math.fround(weightedTarget * value),
        );
        targetNorm[user] = Math.fround(
          targetNorm[user] + Math.fround(weightedTarget * targetValue),
        );
        neighborNorm[user] = Math.fround(
          neighborNorm[user] + Math.fround(Math.fround(weight * value) * value),
        );
      }
    }
    const eligible: Neighbor[] = [];
    for (let user = 0; user < this.userCount; user++) {
      if (overlap[user] < 10 || targetNorm[user] <= 0 || neighborNorm[user] <= 0) continue;
      let similarity = numerator[user] / Math.sqrt(targetNorm[user] * neighborNorm[user]);
      similarity *= overlap[user] / (overlap[user] + 25);
      if (similarity > 0) eligible.push({ userIdx: user, similarity, overlap: overlap[user] });
    }
    eligible.sort((left, right) => right.similarity - left.similarity);
    const count = Math.min(50, eligible.length);
    const similarityByUser = new Float32Array(this.userCount);
    for (const neighbor of eligible) {
      similarityByUser[neighbor.userIdx] = neighbor.similarity;
    }
    const selected: Neighbor[] = [];
    const selectedUsers = new Set<number>();
    const anchorOrder = [...items.keys()].sort((left, right) => (
      residuals[right] * (1 + this.itemIuf[items[right]]) * balances[right]
      - residuals[left] * (1 + this.itemIuf[items[left]]) * balances[left]
    ));
    for (const position of anchorOrder) {
      if (residuals[position] < 0.7) break;
      const item = items[position];
      const start = Number(this.cscIndptr[item]);
      const stop = Number(this.cscIndptr[item + 1]);
      const [users, values] = await Promise.all([
        this.cscIndices.read(start, stop) as Promise<Int32Array>,
        this.cscResiduals.read(start, stop) as Promise<Float32Array>,
      ]);
      const anchors: number[] = [];
      for (let row = 0; row < users.length; row++) {
        if (values[row] >= 0.3 && similarityByUser[users[row]] > 0) {
          anchors.push(users[row]);
        }
      }
      anchors.sort((left, right) => similarityByUser[right] - similarityByUser[left]);
      let added = 0;
      for (const user of anchors) {
        if (selectedUsers.has(user)) continue;
        selected.push({ userIdx: user, similarity: similarityByUser[user], overlap: overlap[user] });
        selectedUsers.add(user);
        added++;
        if (added >= 4 || selected.length >= count) break;
      }
      if (selected.length >= count) break;
    }
    for (const neighbor of eligible) {
      if (selected.length >= count) break;
      if (selectedUsers.has(neighbor.userIdx)) continue;
      selected.push(neighbor);
      selectedUsers.add(neighbor.userIdx);
    }
    return selected.sort((left, right) => right.similarity - left.similarity);
  }

  private likedGenres(ratings: Record<number, number>) {
    const values = Object.values(ratings).sort((a, b) => a - b);
    const threshold = Math.max(7, quantile(values, 0.75));
    const result = new Map<string, number>();
    for (const [malId, rating] of Object.entries(ratings)) {
      if (rating < threshold) continue;
      const item = this.itemByMal.get(Number(malId));
      if (item == null) continue;
      for (const raw of this.catalog[item].genres ?? []) {
        const normalized = raw.trim().toLocaleLowerCase().replace(/\s+/g, " ");
        const genre = TAG_ALIASES[normalized] ?? normalized;
        if (!GENRE_LABELS[genre]) continue;
        result.set(genre, (result.get(genre) ?? 0) + 1);
      }
    }
    return result;
  }

  private matchedTags(item: number, liked: Map<string, number>) {
    const genres = [...new Set((this.catalog[item].genres ?? []).map((raw) => {
      const normalized = raw.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      return TAG_ALIASES[normalized] ?? normalized;
    }))];
    return genres
      .filter((genre) => liked.has(genre) && GENRE_LABELS[genre])
      .sort((left, right) => {
        const leftWeight = (TAG_SPECIFICITY[left] ?? 1) * (1 + Math.min(liked.get(left) ?? 0, 5) / 5);
        const rightWeight = (TAG_SPECIFICITY[right] ?? 1) * (1 + Math.min(liked.get(right) ?? 0, 5) / 5);
        return rightWeight - leftWeight || genres.indexOf(left) - genres.indexOf(right);
      })
      .slice(0, 3)
      .map((genre) => GENRE_LABELS[genre]);
  }

  private evidence(
    ratings: Record<number, number>,
    target: { items: number[]; residuals: number[] },
    neighbors: Neighbor[],
    values: Float32Array[],
    supporting: boolean[],
  ) {
    const balances = seriesBalance(target.items.map((item) => this.seriesKeys[item]));
    const contributions = new Float64Array(target.items.length);
    const neighborMeans = new Float64Array(target.items.length);
    for (let position = 0; position < target.items.length; position++) {
      let weighted = 0;
      let weightSum = 0;
      let contribution = 0;
      for (let neighborPosition = 0; neighborPosition < neighbors.length; neighborPosition++) {
        if (!supporting[neighborPosition]) continue;
        const value = values[neighborPosition][position];
        if (Number.isNaN(value)) continue;
        const similarity = neighbors[neighborPosition].similarity;
        weighted += similarity * value;
        weightSum += similarity;
        const targetValue = target.residuals[position];
        const eventSurprise = (
          this.itemSurprise[target.items[position] * 3 + bucket(targetValue)] +
          this.itemSurprise[target.items[position] * 3 + bucket(value)]
        ) * 0.5;
        const targetWeight = targetValue >= 0.7 ? 2 : targetValue <= -0.7 ? 0.25 : 0.5;
        contribution += similarity * targetWeight
          * (1 + 0.75 * this.itemIuf[target.items[position]] + 0.25 * eventSurprise)
          * targetValue * value;
      }
      if (weightSum) neighborMeans[position] = weighted / weightSum;
      contributions[position] = balances[position] * contribution;
    }
    const order = [...contributions.keys()]
      .filter((index) => contributions[index] > 0)
      .sort((left, right) => Math.abs(contributions[right]) - Math.abs(contributions[left]))
      .slice(0, 3);
    const normalizer = Math.max(sum(order.map((index) => Math.abs(contributions[index]))), 1e-12);
    return order.map((position) => {
      const item = target.items[position];
      const targetValue = target.residuals[position];
      const neighborValue = neighborMeans[position];
      return {
        mal_id: this.malIds[item],
        title: this.catalog[item].title_zh || this.catalog[item].title_en,
        your_rating: ratings[this.malIds[item]],
        signal: targetValue >= 0.7 && neighborValue >= 0.3
          ? "共同喜欢低关注作品"
          : targetValue <= -0.7 && neighborValue <= -0.3
            ? "共同低评大众作品"
            : "整体评价走势接近",
        contribution: round(Math.abs(contributions[position]) / normalizer, 4),
      };
    });
  }
}

let runtime: BrowserRecommender | null = null;
let catalogRuntime: BrowserCatalog | null = null;

class BrowserCatalog {
  private itemByMal: Map<number, BrowserCatalogItem>;

  constructor(private items: BrowserCatalogItem[]) {
    this.itemByMal = new Map(items.map((item) => [item.mal_id, item]));
  }

  search(query: string, limit: number, offset: number) {
    const normalized = query.trim().toLocaleLowerCase();
    const numericId = /^\d+$/.test(normalized) ? Number(normalized) : null;
    const matches = this.items.filter((item) =>
      numericId === item.mal_id ||
      !normalized ||
      [item.title_zh, item.title_native, item.title_en]
        .some((title) => title?.toLocaleLowerCase().includes(normalized)),
    );
    return {
      items: matches.slice(offset, offset + limit).map(publicAnime),
      total: matches.length,
    };
  }

  anime(malId: number) {
    const item = this.itemByMal.get(malId);
    if (!item) throw new Error("未找到这部番剧");
    return publicAnime(item);
  }

  animeMany(malIds: number[]) {
    return malIds.flatMap((malId) => {
      const item = this.itemByMal.get(malId);
      return item ? [publicAnime(item)] : [];
    });
  }
}

async function readyCatalog() {
  if (catalogRuntime) return catalogRuntime;
  const manifest = await catalogManifest() ?? await installedManifest();
  if (!manifest) throw new Error("作品目录正在下载");
  const items = await readJson<BrowserCatalogItem[]>(
    await modelDirectory(false),
    manifest.browser_catalog.path,
  );
  catalogRuntime = new BrowserCatalog(items);
  return catalogRuntime;
}

async function readyRuntime() {
  if (runtime) return runtime;
  const manifest = await installedManifest();
  if (!manifest) throw new Error("模型尚未下载");
  runtime = new BrowserRecommender();
  await runtime.initialize(manifest);
  return runtime;
}

function publicAnime(item: BrowserCatalogItem): Anime {
  return {
    mal_id: item.mal_id,
    title_zh: item.title_zh,
    title_native: item.title_native,
    title_en: item.title_en,
    format: item.format,
    episodes: item.episodes,
    year: item.year,
    release_status: item.release_status,
    synopsis: item.synopsis,
    cover_index: item.cover_index,
    cover_url: item.cover_url,
    platform_mean: item.platform_mean,
    bangumi_score: item.bangumi_score,
    matched_tags: item.matched_tags,
    is_sequel: item.sequel || looksLikeContinuation(item.title_en),
    is_derivative:
      nonPrimaryAnimeIds.has(item.mal_id)
      || isAncillary(item.format, item.title_en),
    is_short_form: shortFormAnimeIds.has(item.mal_id),
  };
}

function seriesKey(title: string | null | undefined) {
  let normalized = (title ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/^(?:the\s+)?(?:movie|film|ova|ona|special)\s*[:-]\s*/, "");
  if (normalized.includes(":")) {
    const prefix = normalized.split(":", 1)[0];
    if ((prefix.match(/[a-z0-9]+/g) ?? []).length >= 2) normalized = prefix;
  }
  const source = (normalized.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .filter((token) => !new Set([
      "season", "part", "cour", "movie", "film", "ova", "ona", "special",
      "recap", "summary", "2nd", "3rd", "4th", "second", "third", "fourth",
      "ii", "iii", "iv",
    ]).has(token) && !/^\d+$/.test(token));
  const width = source[0]?.includes("-") && source[0] !== "k-on"
    ? 1
    : source[1] === "love-ru" ? 2 : Math.min(4, source.length);
  return source.slice(0, width).join(" ");
}

function isAncillary(format: string | null, title: string | null) {
  return ["OVA", "SPECIAL", "TV SPECIAL", "MUSIC", "PV", "CM"].includes(
    (format ?? "").toUpperCase(),
  ) || /\b(?:recap|summary|picture drama|promotional video)\b/i.test(title ?? "");
}

function looksLikeContinuation(title: string | null) {
  const value = (title ?? "").normalize("NFKC");
  return /(?:\b(?:season|part)\s*(?:[2-9]|ii|iii|iv)\b|\b(?:2nd|3rd|4th)\b|[×x]\s*(?:[2-9]|\d{3,4})\b|\br[2-9]\b)/i.test(value)
    || /(?:^|[\s:])(?:II|III|IV)(?:$|[\s:])/.test(value);
}

function requiresSeriesContext(format: string | null, title: string | null) {
  if (isAncillary(format, title)) return true;
  return (format ?? "").toUpperCase() === "MOVIE" &&
    /[:\[\]]|\b(?:movie|film|gekijouban)\b/i.test(title ?? "");
}

function seriesBalance(keys: string[]) {
  const counts = new Map<string, number>();
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  return keys.map((key) => Math.fround(1 / Math.sqrt(counts.get(key) ?? 1)));
}

function upperBound(values: number[], target: number) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle] <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function bucket(value: number) {
  return value <= -0.7 ? 0 : value >= 0.7 ? 2 : 1;
}

function quantile(sorted: number[], percentile: number) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function float32Sum(values: number[]) {
  return values.reduce(
    (total, value) => Math.fround(total + value),
    0,
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

self.addEventListener("message", async (event: MessageEvent<ModelWorkerRequest>) => {
  const request = event.data;
  const send = (response: ModelWorkerResponse) => self.postMessage(response);
  try {
    let value: unknown;
    if (request.type === "status") {
      value = await currentStatus(request.manifestUrl);
    } else if (request.type === "download") {
      value = await downloadModel(request.manifestUrl, (progress) => {
        send({ id: request.id, type: "progress", value: progress });
      });
    } else if (request.type === "delete") {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(MODEL_DIRECTORY, { recursive: true });
      runtime = null;
      catalogRuntime = null;
      value = undefined;
    } else if (request.type === "search") {
      value = (await readyCatalog()).search(request.query, request.limit, request.offset);
    } else if (request.type === "anime") {
      value = (await readyCatalog()).anime(request.malId);
    } else if (request.type === "animeMany") {
      value = (await readyCatalog()).animeMany(request.malIds);
    } else if (request.type === "neighborStats") {
      value = await (await readyRuntime()).neighborStats(request.ratings, request.negativeItems);
    } else {
      value = await (await readyRuntime()).recommend(request.payload);
    }
    send({ id: request.id, type: "result", value });
  } catch (reason) {
    send({
      id: request.id,
      type: "error",
      error: reason instanceof Error ? reason.message : "操作失败",
    });
  }
});

export {};
