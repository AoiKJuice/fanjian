"use client";

import { ChatCircleDots, PlayCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import {
  bangumiSubjectId,
  loadBangumiCommunity,
} from "../lib/bangumi-client";
import { loadBahamutCommunity } from "../lib/bahamut-client";
import { bahamutSubjectId } from "../lib/anime-metadata";

export function AnimeCommunity({
  malId,
}: {
  malId: number;
  title: string;
}) {
  const subjectId = bangumiSubjectId(malId);
  const gamerId = bahamutSubjectId(malId);
  const bangumiQuery = useQuery({
    queryKey: ["bangumi-community", malId],
    queryFn: () => loadBangumiCommunity(malId),
    enabled: Boolean(subjectId),
  });
  const bahamutQuery = useQuery({
    queryKey: ["bahamut-community", gamerId],
    queryFn: () => loadBahamutCommunity(gamerId!),
    enabled: Boolean(gamerId),
  });
  const bangumiEntries = bangumiQuery.data?.entries ?? [];
  const bahamutEntries = bahamutQuery.data?.comments ?? [];
  const loading = (subjectId && bangumiQuery.isPending)
    || (gamerId && bahamutQuery.isPending);

  return (
    <section className="section-block community-section">
      <div className="section-heading">
        <h2>社区评论</h2>
        <ChatCircleDots size={24} weight="duotone" />
      </div>

      {bahamutQuery.data?.watchUrl && (
        <div className="community-source-actions">
          <a
            className="button primary"
            href={bahamutQuery.data.watchUrl}
            target="_blank"
            rel="noreferrer"
          >
            <PlayCircle size={18} /> 在巴哈姆特观看
          </a>
        </div>
      )}

      {loading && !bangumiEntries.length && !bahamutEntries.length ? (
        <div className="community-loading">正在读取社区评论</div>
      ) : bangumiEntries.length || bahamutEntries.length ? (
        <div className="community-groups">
          {bangumiEntries.length > 0 && (
            <section className="community-group">
              <h3>Bangumi</h3>
              <div className="community-list">
                {bangumiEntries.map((entry) => (
                  <article key={`${entry.kind}-${entry.id}`}>
                    <div className="community-entry-heading">
                      <span>{entry.kind}</span>
                      <strong>{entry.title}</strong>
                    </div>
                    {entry.summary && <p>{entry.summary}</p>}
                    <div className="community-entry-meta">
                      <strong>{entry.author}</strong>
                      <span>{entry.replies} 条回复</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {bahamutEntries.length > 0 && (
            <section className="community-group">
              <h3>巴哈姆特</h3>
              <div className="community-list">
                {bahamutEntries.map((entry) => (
                  <article key={entry.id}>
                    <p>{entry.content}</p>
                    <div className="community-entry-meta">
                      <strong>{entry.author}</strong>
                      {entry.createdAt && <span>{entry.createdAt}</span>}
                      <span>{entry.likes} 赞</span>
                      <span>{entry.replies} 条回复</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (bangumiQuery.isError || bahamutQuery.isError) ? (
        <div className="community-loading">社区评论暂时无法读取</div>
      ) : null}
    </section>
  );
}
