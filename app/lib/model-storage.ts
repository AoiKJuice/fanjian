import releasesJson from "./model-releases.json";
import type { BrowserModelManifest, ModelDownloadProgress, ModelInventory, ModelRelease, ModelStatus } from "./model-types";

export const modelReleases = releasesJson as ModelRelease[];
export const MODEL_DIRECTORY = "fanjian-model-v1";
type Entry = { manifest: BrowserModelManifest; directory: string; installed: boolean; verified: Record<string, string> };
type Entries = Record<string, Entry>;
type Access = { getSize(): number; truncate(size: number): void; write(data: Uint8Array, options: { at: number }): number; flush(): void; close(): void };
type Job = { version: string; controller: AbortController; mode?: "pause" | "cancel"; promise: Promise<ModelStatus>; progress?: ModelDownloadProgress };

export async function fileAt(directory: FileSystemDirectoryHandle, path: string, create = false) {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("模型文件路径无效");
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}
async function readJson<T>(directory: FileSystemDirectoryHandle, path: string): Promise<T | null> {
  try { return JSON.parse(await (await (await fileAt(directory, path)).getFile()).text()) as T; }
  catch (error) { if ((error as DOMException).name === "NotFoundError") return null; throw error; }
}
async function writeJson(directory: FileSystemDirectoryHandle, path: string, value: unknown) {
  const stream = await (await fileAt(directory, path, true)).createWritable();
  try { await stream.write(JSON.stringify(value)); await stream.close(); }
  catch (error) { await stream.abort().catch(() => undefined); throw error; }
}
async function lock<T>(name: string, action: () => Promise<T>, exclusiveDownload = false): Promise<T> {
  if (!navigator.locks) return action();
  return navigator.locks.request(name, { ifAvailable: exclusiveDownload }, async (lease) => {
    if (!lease) throw new Error("另一个页面正在下载模型");
    return action();
  });
}

export class ModelStorage {
  private job: Job | null = null;
  constructor(
    private hash: (file: File, signal: AbortSignal) => Promise<string>,
    private changed: () => void,
    private releases = modelReleases,
  ) {}
  async root() { return (await navigator.storage.getDirectory()).getDirectoryHandle(MODEL_DIRECTORY, { create: true }); }
  async active() { return readJson<BrowserModelManifest>(await this.root(), "installed.json"); }

  private async entries() {
    return lock("fanjian-model-metadata", async () => {
      const root = await this.root();
      const entries = await readJson<Entries>(root, "versions.json") ?? {};
      const legacy = await readJson<BrowserModelManifest>(root, "installed.json");
      const known = this.releases.map((release) => release.manifest);
      if (legacy && !known.some((m) => m.model_version === legacy.model_version)) known.push(legacy);
      let modified = false;
      for (const manifest of known) {
        if (entries[manifest.model_version]) continue;
        let legacyFiles = legacy?.model_version === manifest.model_version;
        if (!legacyFiles) {
          for (const record of [manifest.browser_catalog, ...manifest.files]) {
            try { if ((await (await fileAt(root, record.path)).getFile()).size > 0) { legacyFiles = true; break; } }
            catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
          }
        }
        entries[manifest.model_version] = {
          manifest, directory: legacyFiles ? "" : `versions/${encodeURIComponent(manifest.model_version)}`,
          installed: legacy?.model_version === manifest.model_version, verified: {},
        };
        modified = true;
      }
      if (modified) await writeJson(root, "versions.json", entries);
      return entries;
    });
  }
  private async save(entry: Entry) {
    await lock("fanjian-model-metadata", async () => {
      const root = await this.root();
      const entries = await readJson<Entries>(root, "versions.json") ?? {};
      entries[entry.manifest.model_version] = entry;
      await writeJson(root, "versions.json", entries);
    });
  }
  private async entry(version: string) {
    const entry = (await this.entries())[version];
    if (!entry) throw new Error("未找到模型版本");
    return entry;
  }
  async directory(manifest: BrowserModelManifest, create = false) {
    const entry = await this.entry(manifest.model_version);
    let directory = await this.root();
    for (const part of entry.directory.split("/").filter(Boolean)) directory = await directory.getDirectoryHandle(part, { create });
    return directory;
  }
  private async statusOf(entry: Entry, activeVersion?: string): Promise<ModelStatus> {
    const manifest = entry.manifest;
    let bytes = 0;
    let complete = entry.installed;
    try {
      const directory = await this.directory(manifest);
      for (const record of [manifest.browser_catalog, ...manifest.files]) {
        try {
          const size = (await (await fileAt(directory, record.path)).getFile()).size;
          bytes += Math.min(size, record.bytes);
          if (size !== record.bytes) complete = false;
        } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; complete = false; }
      }
    } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; complete = false; }
    if (this.job?.version === manifest.model_version && this.job.progress) return { ...this.job.progress, activeVersion };
    return { state: complete ? "ready" : bytes ? "paused" : "missing", downloadedBytes: bytes, totalBytes: manifest.total_bytes, manifest, activeVersion };
  }
  async status(): Promise<ModelStatus> {
    const active = await this.active();
    const manifest = active ?? this.releases[0].manifest;
    const status = await this.statusOf(await this.entry(manifest.model_version), active?.model_version);
    return status.state === "ready" ? status : { ...status, activeVersion: undefined };
  }
  async inventory(): Promise<ModelInventory> {
    const activeVersion = (await this.active())?.model_version;
    const entries = await this.entries();
    return {
      activeVersion,
      releases: await Promise.all(Object.values(entries).map(async (entry) => ({
        ...(this.releases.find((r) => r.manifest.model_version === entry.manifest.model_version) ?? {
          title: entry.manifest.model_version, publishedAt: "", releaseTag: "", manifest: entry.manifest,
        }), status: await this.statusOf(entry, activeVersion),
      }))),
    };
  }
  async catalog() {
    const active = await this.active();
    if (active) return active;
    // Preserve the catalog already downloaded by the previous application.
    const legacy = await readJson<BrowserModelManifest>(await this.root(), ".catalog-installed.json");
    const entries = await this.entries();
    for (const entry of Object.values(entries)) {
      const record = entry.manifest.browser_catalog;
      if (entry.verified[record.path] === record.sha256 || legacy?.model_version === entry.manifest.model_version) return entry.manifest;
    }
    return null;
  }
  async activate(version: string) {
    return lock("fanjian-model-selection", async () => {
    const entry = await this.entry(version);
    if ((await this.statusOf(entry)).state !== "ready") throw new Error("此版本尚未下载完成");
    await lock("fanjian-model-metadata", async () => writeJson(await this.root(), "installed.json", entry.manifest));
    this.changed();
    return this.status();
    });
  }
  async remove(version: string) {
    return lock("fanjian-model-download", () => lock("fanjian-model-selection", async () => {
    if ((await this.active())?.model_version === version) throw new Error("请先切换到其他版本");
    if (this.job?.version === version) throw new Error("请先取消下载");
    await this.clear(await this.entry(version));
    this.changed();
    }), true);
  }
  private async clear(entry: Entry) {
    try {
      const directory = await this.directory(entry.manifest);
      for (const record of [entry.manifest.browser_catalog, ...entry.manifest.files]) {
        try {
          const parts = record.path.split("/");
          let parent = directory;
          for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
          await parent.removeEntry(parts.at(-1)!);
        } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
      }
    } catch (error) { if ((error as DOMException).name !== "NotFoundError") throw error; }
    entry.installed = false;
    entry.verified = {};
    await this.save(entry);
    const root = await this.root();
    const legacy = await readJson<BrowserModelManifest>(root, ".catalog-installed.json");
    if (legacy?.model_version === entry.manifest.model_version) await root.removeEntry(".catalog-installed.json");
  }
  async pause() {
    if (!this.job) return this.status();
    const job = this.job;
    job.mode = "pause";
    job.controller.abort();
    return job.promise;
  }
  async cancel(version: string) {
    if (this.job?.version === version) {
      const job = this.job;
      job.mode = "cancel";
      job.controller.abort();
      return job.promise;
    }
    return lock("fanjian-model-download", async () => {
      const entry = await this.entry(version);
      if (!entry.installed) await this.clear(entry);
      return this.statusOf(entry, (await this.active())?.model_version);
    }, true);
  }
  download(version: string | undefined, report: (progress: ModelDownloadProgress) => void) {
    if (this.job) throw new Error("已有模型正在下载");
    const job: Job = { version: version ?? this.releases[0].manifest.model_version, controller: new AbortController(), promise: Promise.resolve({ state: "missing", downloadedBytes: 0, totalBytes: 0 }) };
    this.job = job;
    job.promise = lock("fanjian-model-download", () => this.perform(job, report), true).finally(() => { if (this.job === job) this.job = null; });
    return job.promise;
  }
  private async perform(job: Job, report: (progress: ModelDownloadProgress) => void): Promise<ModelStatus> {
    const entry = await this.entry(job.version);
    const manifest = entry.manifest;
    const signal = job.controller.signal;
    let lastReport = 0;
    const emit = (state: ModelDownloadProgress["state"], bytes: number, path: string) => {
      const previous = job.progress;
      job.progress = { state, downloadedBytes: bytes, totalBytes: manifest.total_bytes, currentFile: path, manifest, activeVersion };
      if (Date.now() - lastReport >= 100 || previous?.state !== state || previous?.currentFile !== path || bytes === manifest.total_bytes) {
        lastReport = Date.now(); report(job.progress);
      }
    };
    const activeVersion = (await this.active())?.model_version;
    try {
      signal.throwIfAborted();
      if (entry.installed && (await this.statusOf(entry)).state === "ready") { job.progress = undefined; return this.statusOf(entry, activeVersion); }
      entry.installed = false;
      await navigator.storage.persist?.();
      const directory = await this.directory(manifest, true);
      let completed = 0;
      for (const record of [manifest.browser_catalog, ...manifest.files]) {
        signal.throwIfAborted();
        const handle = await fileAt(directory, record.path, true);
        let file = await handle.getFile();
        if (file.size !== record.bytes || entry.verified[record.path] !== record.sha256) {
          if (file.size !== record.bytes) {
            const access = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<Access> }).createSyncAccessHandle();
            try {
              let offset = access.getSize();
              if (offset > record.bytes) { access.truncate(0); offset = 0; }
              emit("downloading", completed + offset, record.path);
              let timer = setTimeout(() => job.controller.abort(new Error("下载连接超时")), 30_000);
              try {
                const response = await fetch(record.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
                if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
                if (response.status === 206) {
                  const range = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
                  if (!range || +range[1] !== offset || +range[3] !== record.bytes || +range[2] !== record.bytes - 1) throw new Error("下载范围不匹配");
                } else if (response.status === 200) { offset = 0; access.truncate(0); }
                else throw new Error("下载响应无效");
                if (!response.body) throw new Error("下载没有返回数据");
                const reader = response.body.getReader();
                try {
                  while (true) {
                    signal.throwIfAborted();
                    clearTimeout(timer);
                    timer = setTimeout(() => job.controller.abort(new Error("下载连接超时")), 30_000);
                    const { done, value } = await reader.read();
                    if (done) break;
                    signal.throwIfAborted();
                    if (offset + value.byteLength > record.bytes) throw new Error("模型文件大小不符");
                    let written = 0;
                    while (written < value.byteLength) {
                      const count = access.write(value.subarray(written), { at: offset + written });
                      if (!count) throw new Error("本地存储写入失败");
                      written += count;
                    }
                    offset += written;
                    access.flush();
                    emit("downloading", completed + offset, record.path);
                  }
                } finally { await reader.cancel().catch(() => undefined); }
              } finally { clearTimeout(timer); }
            } finally { try { access.flush(); } finally { access.close(); } }
            file = await handle.getFile();
          }
          signal.throwIfAborted();
          if (file.size !== record.bytes) throw new Error("模型文件大小不符");
          emit("verifying", completed + record.bytes, record.path);
          if (await this.hash(file, signal) !== record.sha256.toLowerCase()) {
            const stream = await handle.createWritable();
            await stream.truncate(0); await stream.close();
            throw new Error("模型校验失败，请继续下载");
          }
          entry.verified[record.path] = record.sha256;
          await this.save(entry);
        }
        completed += record.bytes;
      }
      signal.throwIfAborted();
      entry.installed = true;
      await this.save(entry);
      job.progress = undefined;
      if (!(await this.active())) await this.activate(job.version);
      this.changed();
      return this.statusOf(entry, (await this.active())?.model_version);
    } catch (error) {
      job.controller.abort(error);
      job.progress = undefined;
      if (job.mode === "cancel") { await this.clear(entry); this.changed(); }
      const status = await this.statusOf(entry, (await this.active())?.model_version);
      if (job.mode) return { ...status, state: job.mode === "pause" ? "paused" : "missing" };
      return { ...status, state: "error", error: error instanceof Error ? error.message : "模型下载失败" };
    }
  }
}
