// This route serves only immutable release assets, without using the web origin.
const RELEASE = "model-2026-09-25";
const PREFIX = `/tools/anime-affinity/model/releases/${RELEASE}/`;
const ASSETS = new Set([
  "catalog.json", "disliked_to_high.bin", "disliked_to_low.bin", "ease.bin",
  "liked_to_low.bin", "provenance.json", "ranker.json",
]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
};

export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const name = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : "";
    if (!ASSETS.has(name)) return new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET, HEAD, OPTIONS" } });
    }
    const headers = new Headers();
    for (const key of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
      if (request.headers.has(key)) headers.set(key, request.headers.get(key));
    }
    const upstream = await fetch(
      `https://github.com/AoiKJuice/fanjian/releases/download/${RELEASE}/${name}`,
      { method: request.method, headers, redirect: "follow" },
    );
    const outgoing = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS)) outgoing.set(key, value);
    outgoing.set("Cache-Control", upstream.ok || upstream.status === 304
      ? "public, max-age=31536000, immutable" : "no-store");
    outgoing.delete("set-cookie");
    outgoing.delete("content-disposition");
    return new Response(upstream.body, { status: upstream.status, headers: outgoing });
  },
};
