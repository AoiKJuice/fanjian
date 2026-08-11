import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterRecommendationsByBangumiScore,
  loadBangumiCommunity,
} from "../app/lib/bangumi-client";
import type { Recommendation } from "../app/lib/data";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bangumi community data", () => {
  it("maps discussions and long reviews without a server proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      topic: [{
        id: 12,
        title: "讨论标题",
        replies: 4,
        timestamp: 100,
        user: { nickname: "讨论用户" },
      }],
      blog: [{
        id: 34,
        title: "长评标题",
        summary: "长评摘要",
        replies: 2,
        timestamp: 200,
        user: { username: "reviewer" },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadBangumiCommunity(35860);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result?.entries.map((entry) => entry.kind)).toEqual(["长评", "讨论"]);
    expect(result?.entries[0]).toMatchObject({
      title: "长评标题",
      summary: "长评摘要",
      author: "reviewer",
      url: "https://bgm.tv/blog/34",
    });
  });

  it("filters recommendations with scores loaded directly from Bangumi", async () => {
    const fetchMock = vi.fn((request: Request) => {
      const score = request.url.includes("/253?") ? 8.4 : 6.2;
      return Promise.resolve(new Response(JSON.stringify({ rating: { score } }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const recommendation = (malId: number): Recommendation => ({
      anime: {
        mal_id: malId,
        title_zh: String(malId),
        title_native: "",
        title_en: "",
        format: "TV",
        episodes: 12,
        year: 2020,
        release_status: "FINISHED",
        synopsis: "",
        cover_index: 0,
        bangumi_score: null,
      },
      rank_score: 1,
      affinity: 1,
      confidence: "高",
      support: 20,
      effective_sample_size: 10,
      reason: "",
      evidence: [],
      neighbor_distribution: {},
      risk: "",
    });

    const result = await filterRecommendationsByBangumiScore([
      recommendation(1),
      recommendation(5),
    ], 7);

    expect(result.map((item) => item.anime.mal_id)).toEqual([1]);
    expect(result[0].anime.bangumi_score).toBe(8.4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
