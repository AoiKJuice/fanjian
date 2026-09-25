import { afterEach, expect, it, vi } from "vitest";
import { createManifestLoader } from "../app/lib/model-manifest";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shares concurrent checks and caches successful responses for one minute", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json({ model_version: "v1" }));
  vi.stubGlobal("fetch", fetchMock);
  const load = createManifestLoader();
  const results = await Promise.all([load("/manifest"), load("/manifest"), load("/manifest")]);
  expect(results.map((value) => value.model_version)).toEqual(["v1", "v1", "v1"]);
  await load("/manifest");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_001);
  await load("/manifest");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("checks for updated URLs before a download even while the cache is fresh", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ model_version: "v1" }))
    .mockResolvedValueOnce(Response.json({ model_version: "v2" }));
  vi.stubGlobal("fetch", fetchMock);
  const load = createManifestLoader();
  await load("/manifest");
  expect((await load("/manifest", { fresh: true })).model_version).toBe("v2");
});

it("aborts a stalled request and allows the next attempt to succeed", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  vi.stubGlobal("fetch", fetchMock);
  const load = createManifestLoader();
  const failed = expect(load("/manifest", { timeoutMs: 2500 })).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(2500);
  await failed;
  fetchMock.mockImplementation(async () => Response.json({ model_version: "v2" }));
  expect((await load("/manifest")).model_version).toBe("v2");
});

it("does not cache server errors", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ model_version: "v1" }));
  vi.stubGlobal("fetch", fetchMock);
  const load = createManifestLoader();
  await expect(load("/manifest")).rejects.toThrow("503");
  expect((await load("/manifest")).model_version).toBe("v1");
});
