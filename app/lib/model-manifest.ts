import type { BrowserModelManifest } from "./model-types";

// A page can request status from several panels at once. Share the network work.
export function createManifestLoader() {
  const cached = new Map<string, { manifest: BrowserModelManifest; expires: number }>();
  const pending = new Map<string, Promise<BrowserModelManifest>>();
  return function fetchManifest(url: string, options: { fresh?: boolean; timeoutMs?: number } = {}) {
    const entry = cached.get(url);
    if (!options.fresh && entry && entry.expires > Date.now()) return Promise.resolve(entry.manifest);
    const active = pending.get(url);
    if (active) return active;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
    const task = (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`模型清单读取失败：HTTP ${response.status}`);
        const manifest = await response.json() as BrowserModelManifest;
        cached.set(url, { manifest, expires: Date.now() + 60_000 });
        return manifest;
      } finally {
        clearTimeout(timeout);
        pending.delete(url);
      }
    })();
    pending.set(url, task);
    return task;
  };
}
