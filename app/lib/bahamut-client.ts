"use client";

const BAHAMUT_COMMUNITY_BASE = (
  process.env.NEXT_PUBLIC_BAHAMUT_COMMUNITY_URL
  ?? "https://fanjian-model.pjjzxcvbnm.workers.dev/community/bahamut"
).replace(/\/$/, "");

export type BahamutComment = {
  id: string;
  content: string;
  author: string;
  createdAt: string;
  likes: number;
  replies: number;
};

export type BahamutCommunity = {
  gamerId: number;
  watchUrl: string | null;
  sourceUrl: string;
  comments: BahamutComment[];
};

type BahamutResponse = {
  gamer_id?: number;
  watch_url?: string | null;
  source_url?: string;
  comments?: Array<{
    id?: string | number;
    content?: string;
    author?: string;
    created_at?: string;
    likes?: number;
    replies?: number;
  }>;
};

export async function loadBahamutCommunity(
  gamerId: number,
): Promise<BahamutCommunity> {
  const response = await fetch(`${BAHAMUT_COMMUNITY_BASE}/${gamerId}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`巴哈姆特返回 HTTP ${response.status}`);
  const payload = await response.json() as BahamutResponse;
  return {
    gamerId,
    watchUrl: typeof payload.watch_url === "string" ? payload.watch_url : null,
    sourceUrl: payload.source_url
      ?? `https://acg.gamer.com.tw/acgDetail.php?s=${gamerId}`,
    comments: (payload.comments ?? []).flatMap((item) => {
      const id = String(item.id ?? "");
      const content = item.content?.trim() ?? "";
      if (!id || !content) return [];
      return [{
        id,
        content,
        author: item.author?.trim() || "巴哈姆特用户",
        createdAt: item.created_at?.trim() ?? "",
        likes: Number(item.likes) || 0,
        replies: Number(item.replies) || 0,
      }];
    }),
  };
}
