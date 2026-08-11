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

function jsonResponse(payload, status = 200, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function parseBahamutDetail(html, gamerId) {
  const watchMatch = html.match(/animeVideo\.php\?sn=(\d+)/i);
  const reviewMatch = html.match(
    /new\s+Bahamut\.AcgReview\(\s*['"]#acg_review['"]\s*,\s*(\d+)\s*,\s*(\{[\s\S]*?\})\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/,
  );
  return {
    gamerId,
    watchUrl: watchMatch
      ? `https://ani.gamer.com.tw/animeVideo.php?sn=${watchMatch[1]}`
      : null,
    reviewId: reviewMatch ? Number(reviewMatch[3]) : null,
    mediaType: reviewMatch ? Number(reviewMatch[4]) : null,
  };
}

export function normalizeBahamutComments(payload) {
  const groups = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  return groups
    .flat(2)
    .filter((item) => item && typeof item === "object")
    .flatMap((item) => {
      const content = typeof item.content === "string" ? item.content.trim() : "";
      const id = String(item.id ?? "");
      if (!id || !content) return [];
      return [{
        id,
        content,
        author: String(item.publisher?.name ?? "巴哈姆特用户").trim(),
        created_at: String(item.ctime ?? "").trim(),
        likes: Number(item.likeCount) || 0,
        replies: Number(item.commentCount) || 0,
      }];
    })
    .slice(0, 8);
}

async function bahamutCommunity(gamerId, method) {
  const sourceUrl = `https://acg.gamer.com.tw/acgDetail.php?s=${gamerId}`;
  const upstreamHeaders = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-TW,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 fanjian-community-worker",
  };
  const detailResponse = await fetch(sourceUrl, {
    headers: upstreamHeaders,
    redirect: "follow",
  });
  if (!detailResponse.ok) {
    return jsonResponse({ error: `Bahamut returned HTTP ${detailResponse.status}` }, 502, method);
  }
  const detail = parseBahamutDetail(await detailResponse.text(), gamerId);
  let comments = [];
  if (detail.reviewId && detail.mediaType) {
    const reviewsUrl = new URL("https://api.gamer.com.tw/acg/v1/reviews_list.php");
    reviewsUrl.searchParams.set("sn", String(detail.reviewId));
    reviewsUrl.searchParams.set("t", String(detail.mediaType));
    const reviewsResponse = await fetch(reviewsUrl, {
      headers: {
        Accept: "application/json",
        Referer: sourceUrl,
        "User-Agent": upstreamHeaders["User-Agent"],
      },
    });
    if (reviewsResponse.ok) {
      comments = normalizeBahamutComments(await reviewsResponse.json());
    }
  }
  return jsonResponse({
    gamer_id: gamerId,
    watch_url: detail.watchUrl,
    source_url: sourceUrl,
    comments,
  }, 200, method);
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
    const bahamutMatch = requestUrl.pathname.match(/^\/community\/bahamut\/(\d+)\/?$/);
    if (bahamutMatch) {
      try {
        return await bahamutCommunity(Number(bahamutMatch[1]), request.method);
      } catch (error) {
        return jsonResponse({ error: String(error) }, 502, request.method);
      }
    }
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
