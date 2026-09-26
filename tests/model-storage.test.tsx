// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelStorage, MODEL_DIRECTORY } from "../app/lib/model-storage";
import type { ModelRelease } from "../app/lib/model-types";

const missing = () => new DOMException("Missing", "NotFoundError");
class MemoryFile {
  bytes = new Uint8Array();
  async getFile() { return new File([this.bytes], "file"); }
  async createWritable() {
    let buffer = new Uint8Array();
    return { write: async (text: string) => { buffer = new TextEncoder().encode(text); }, truncate: async () => { buffer = new Uint8Array(); }, close: async () => { this.bytes = buffer; }, abort: async () => undefined };
  }
  async createSyncAccessHandle() {
    return { getSize: () => this.bytes.length, truncate: (size: number) => { this.bytes = this.bytes.slice(0, size); },
      write: (data: Uint8Array, { at }: { at: number }) => { const bytes = new Uint8Array(Math.max(at + data.length, this.bytes.length)); bytes.set(this.bytes); bytes.set(data, at); this.bytes = bytes; return data.length; }, flush() {}, close() {} };
  }
}
class MemoryDirectory {
  dirs = new Map<string, MemoryDirectory>();
  files = new Map<string, MemoryFile>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.dirs.has(name)) { if (!options?.create) throw missing(); this.dirs.set(name, new MemoryDirectory()); }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) { if (!options?.create) throw missing(); this.files.set(name, new MemoryFile()); }
    return this.files.get(name)!;
  }
  async removeEntry(name: string) { if (!this.files.delete(name) && !this.dirs.delete(name)) throw missing(); }
}
const content = new Uint8Array(1024).map((_, i) => i % 251);
const digest = createHash("sha256").update(content).digest("hex");
const releases: ModelRelease[] = ["new", "old"].map((version) => ({ title: version, publishedAt: "2026-09-26", releaseTag: version,
  manifest: { schema_version: 1, model_version: version, data_version: "data", total_bytes: 2048, catalog_items: 1, training_users: 1, training_ratings: 1,
    browser_catalog: { path: `${version}/catalog.json`, bytes: 1024, sha256: digest, url: `https://models.test/${version}/catalog.json` },
    files: [{ path: `${version}/weights.bin`, bytes: 1024, sha256: digest, url: `https://models.test/${version}/weights.bin` }],
  },
}));
let root: MemoryDirectory;
const fetchMock = vi.fn<typeof fetch>();
const hash = async (file: File, signal: AbortSignal) => { signal.throwIfAborted(); return createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex"); };
const manager = () => new ModelStorage(hash, vi.fn(), releases);
function response(_url: unknown, options?: RequestInit) {
  const range = new Headers(options?.headers).get("Range");
  const offset = range ? Number(range.match(/\d+/)![0]) : 0;
  return Promise.resolve(new Response(content.slice(offset), { status: offset ? 206 : 200, headers: offset ? { "Content-Range": `bytes ${offset}-1023/1024` } : {} }));
}
beforeEach(() => {
  root = new MemoryDirectory();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root, persist: async () => true } });
  fetchMock.mockReset().mockImplementation(response);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("keeps both versions and switches the active model offline", async () => {
  const store = manager();
  expect((await store.download("old", vi.fn())).state).toBe("ready");
  await store.download("new", vi.fn());
  expect((await store.active())?.model_version).toBe("old");
  expect((await store.inventory()).releases.every((r) => r.status.state === "ready")).toBe(true);
  fetchMock.mockRejectedValue(new Error("offline"));
  await store.activate("new");
  expect((await manager().status()).manifest?.model_version).toBe("new");
  await store.activate("old");
  expect((await store.status()).state).toBe("ready");
  await expect(store.remove("old")).rejects.toThrow("请先切换");
  await store.remove("new");
  expect((await store.inventory()).releases[0].status.state).toBe("missing");
  expect((await store.status()).state).toBe("ready");
});

async function pausedStore() {
  const store = manager();
  fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { setTimeout(() => controller.enqueue(content.slice(0, 128)), 120); } })));
  let paused = false;
  const result = await store.download("new", (progress) => {
    if (!paused && progress.downloadedBytes >= 128) { paused = true; void store.pause(); }
  });
  expect(result.state).toBe("paused");
  expect(result.downloadedBytes).toBe(128);
  return store;
}

it("persists paused bytes across reload and resumes at the exact offset", async () => {
  await pausedStore();
  const reloaded = manager();
  expect((await reloaded.inventory()).releases[0].status.downloadedBytes).toBe(128);
  expect((await reloaded.download("new", vi.fn())).state).toBe("ready");
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Range")).toBe("bytes=128-");
});

it("cancels only the unfinished version and preserves the active version", async () => {
  const store = manager();
  await store.download("old", vi.fn());
  fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { setTimeout(() => controller.enqueue(content.slice(0, 128)), 120); } })));
  let cancelled = false;
  const result = await store.download("new", (progress) => {
    if (!cancelled && progress.downloadedBytes >= 128) { cancelled = true; void store.cancel("new"); }
  });
  expect(result.state).toBe("missing");
  expect(result.downloadedBytes).toBe(0);
  expect((await store.status()).manifest?.model_version).toBe("old");
  expect((await store.status()).state).toBe("ready");
});

it("restarts safely if the server ignores Range", async () => {
  const store = await pausedStore();
  fetchMock.mockImplementationOnce(async () => new Response(content));
  expect((await store.download("new", vi.fn())).state).toBe("ready");
});

it("rejects a mismatched Content-Range without overwriting saved bytes", async () => {
  const store = await pausedStore();
  fetchMock.mockImplementationOnce(async () => new Response(content, { status: 206, headers: { "Content-Range": "bytes 0-1023/1024" } }));
  const result = await store.download("new", vi.fn());
  expect(result.state).toBe("error");
  expect(result.downloadedBytes).toBe(128);
  expect(await store.active()).toBeNull();
});

it("rejects corrupt content and permits a clean retry", async () => {
  const store = manager();
  fetchMock.mockImplementationOnce(async () => new Response(new Uint8Array(1024)));
  const result = await store.download("new", vi.fn());
  expect(result.state).toBe("error");
  expect(result.downloadedBytes).toBe(0);
  expect(await store.active()).toBeNull();
  expect((await store.download("new", vi.fn())).state).toBe("ready");
});

it("preserves committed progress after a network interruption", async () => {
  const store = manager();
  let reads = 0;
  fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({ pull(controller) { if (++reads === 1) controller.enqueue(content.slice(0, 128)); else controller.error(new Error("connection lost")); } })));
  const result = await store.download("new", vi.fn());
  expect(result.state).toBe("error");
  expect(result.downloadedBytes).toBe(128);
  expect((await manager().download("new", vi.fn())).state).toBe("ready");
});

it("adopts an existing installation without copying or redownloading it", async () => {
  const directory = await root.getDirectoryHandle(MODEL_DIRECTORY, { create: true });
  const legacy = await directory.getDirectoryHandle("old", { create: true });
  for (const name of ["catalog.json", "weights.bin"]) (await legacy.getFileHandle(name, { create: true })).bytes = content;
  (await directory.getFileHandle("installed.json", { create: true })).bytes = new TextEncoder().encode(JSON.stringify(releases[1].manifest));
  const store = manager();
  expect((await store.status()).state).toBe("ready");
  expect(await store.directory(releases[1].manifest)).toBe(directory);
  expect(fetchMock).not.toHaveBeenCalled();
});
