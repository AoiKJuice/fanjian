import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBangumiCommunity } from "../app/lib/bangumi-client";

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
});
