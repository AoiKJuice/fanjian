const RELEASE_BASE =
  "https://github.com/AoiKJuice/fanjian/releases/download/model-2026-07-28";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, If-Range, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

const worker = {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method Not Allowed", 405);
    }

    const requestUrl = new URL(request.url);
    const assetName = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
    if (!assetName) return textResponse("fanjian model proxy", 200);
    if (!/^[A-Za-z0-9._-]+$/.test(assetName)) {
      return textResponse("Not Found", 404);
    }

    const upstreamHeaders = new Headers({
      Accept: "application/octet-stream",
      "User-Agent": "fanjian-model-worker",
    });
    for (const name of [
      "Range",
      "If-Range",
      "If-None-Match",
      "If-Modified-Since",
    ]) {
      const value = request.headers.get(name);
      if (value) upstreamHeaders.set(name, value);
    }

    try {
      const upstream = await fetch(
        `${RELEASE_BASE}/${encodeURIComponent(assetName)}`,
        {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "follow",
        },
      );
      const responseHeaders = new Headers(upstream.headers);
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(name, value);
      }
      responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      responseHeaders.delete("Content-Disposition");
      responseHeaders.delete("Content-Security-Policy");
      responseHeaders.delete("Set-Cookie");

      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return textResponse(`GitHub request failed: ${String(error)}`, 502);
    }
  },
};

export default worker;
