import { afterEach, expect, it, vi } from "vitest";
import worker from "../deploy/cloudflare-ranker-worker.js";

const base = "https://www.aoikjuice.com/tools/anime-affinity/model/releases/model-2026-09-25/";
afterEach(() => vi.unstubAllGlobals());

it("streams partial model downloads directly from GitHub with range metadata", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2]), {
    status: 206, headers: { "Content-Range": "bytes 10-11/100", "Content-Length": "2" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await worker.fetch(new Request(base + "ease.bin", { headers: { Range: "bytes=10-11" } }));
  expect(fetchMock.mock.calls[0][0]).toBe("https://github.com/AoiKJuice/fanjian/releases/download/model-2026-09-25/ease.bin");
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Range")).toBe("bytes=10-11");
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 10-11/100");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
});

it("does not forward unknown assets, unrelated routes, or writes", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect((await worker.fetch(new Request(base + "private.json"))).status).toBe(404);
  expect((await worker.fetch(new Request("https://www.aoikjuice.com/"))).status).toBe(404);
  expect((await worker.fetch(new Request(base + "ease.bin", { method: "POST" }))).status).toBe(405);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("answers CORS preflight without requesting a large file", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const response = await worker.fetch(new Request(base + "ease.bin", { method: "OPTIONS" }));
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Range");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserves upstream errors without caching them", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
  const response = await worker.fetch(new Request(base + "ease.bin"));
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
