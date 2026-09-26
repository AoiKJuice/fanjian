// This route serves only immutable release assets, without using the web origin.
import releases from "../app/lib/model-releases.json";
const ASSETS = new Map(releases.flatMap((release) =>
  [release.manifest.browser_catalog, ...release.manifest.files].map((file) => [
    file.url,
    `https://github.com/AoiKJuice/fanjian/releases/download/${release.releaseTag}/${file.url.split("/").at(-1)}`,
  ]),
));
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
};

export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const upstreamUrl = ASSETS.get(pathname);
    if (!upstreamUrl) return new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "GET, HEAD, OPTIONS" } });
    }
    const headers = new Headers();
    for (const key of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
      if (request.headers.has(key)) headers.set(key, request.headers.get(key));
    }
    const upstream = await fetch(
      upstreamUrl,
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
