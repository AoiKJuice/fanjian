"use client";

import {
  ArrowSquareOut,
  ChatCircleDots,
  PlayCircle,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import {
  bangumiSubjectId,
  loadBangumiCommunity,
} from "../lib/bangumi-client";
import { bahamutSubjectId } from "../lib/anime-metadata";

export function AnimeCommunity({
  malId,
  title,
}: {
  malId: number;
  title: string;
}) {
  const subjectId = bangumiSubjectId(malId);
  const gamerId = bahamutSubjectId(malId);
  const communityQuery = useQuery({
    queryKey: ["bangumi-community", malId],
    queryFn: () => loadBangumiCommunity(malId),
    enabled: Boolean(subjectId),
  });
  const entries = communityQuery.data?.entries ?? [];

  return (
    <section className="section-block community-section">
      <div className="section-heading">
        <h2>社区评论</h2>
        <ChatCircleDots size={24} weight="duotone" />
      </div>
      <div className="community-source-actions">
        {subjectId && (
          <a
            className="button secondary"
            href={`https://bgm.tv/subject/${subjectId}/comments`}
            target="_blank"
            rel="noreferrer"
          >
            <ChatCircleDots size={18} /> Bangumi 评论
          </a>
        )}
        {gamerId && (
          <a
            className="button secondary"
            href={`https://acg.gamer.com.tw/acgDetail.php?s=${gamerId}#acg_review`}
            target="_blank"
            rel="noreferrer"
          >
            <ChatCircleDots size={18} /> 巴哈姆特评论
          </a>
        )}
        <a
          className="button secondary"
          href={`https://ani.gamer.com.tw/search.php?kw=${encodeURIComponent(title)}`}
          target="_blank"
          rel="noreferrer"
        >
          <PlayCircle size={18} /> 动画疯搜索观看
        </a>
        <a
          className="button secondary"
          href={`https://myanimelist.net/anime/${malId}/reviews`}
          target="_blank"
          rel="noreferrer"
        >
          <ArrowSquareOut size={18} /> MyAnimeList 评论
        </a>
      </div>

      {subjectId && communityQuery.isPending ? (
        <div className="community-loading">正在读取 Bangumi 社区内容</div>
      ) : entries.length > 0 ? (
        <div className="community-list">
          {entries.map((entry) => (
            <a
              key={`${entry.kind}-${entry.id}`}
              href={entry.url}
              target="_blank"
              rel="noreferrer"
            >
              <div className="community-entry-heading">
                <span>{entry.kind}</span>
                <strong>{entry.title}</strong>
                <ArrowSquareOut size={17} aria-hidden />
              </div>
              {entry.summary && <p>{entry.summary}</p>}
              <div className="community-entry-meta">
                <strong>{entry.author}</strong>
                <span>{entry.replies} 条回复</span>
              </div>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}
