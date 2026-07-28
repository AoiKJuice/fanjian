"use client";

import {
  BookmarkSimple,
  EyeSlash,
  Star,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import type { Recommendation } from "../lib/data";
import { AnimeCover } from "./anime-cover";

export function RecommendationCard({
  item,
  compact = false,
  runId = 31,
  onFeedback,
}: {
  item: Recommendation;
  compact?: boolean;
  runId?: number;
  onFeedback?: (
    action: "favorite" | "hide",
    malId: number,
  ) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<"favorite" | "hide" | null>(null);
  const [pending, setPending] = useState<"favorite" | "hide" | null>(null);
  const matchedTags = item.anime.matched_tags?.slice(0, 3) ?? [];

  if (feedback === "hide") {
    return null;
  }

  if (compact) {
    return (
      <article className="recommendation-compact">
        <Link href={`/recommendations/${runId}/${item.anime.mal_id}`}>
          <AnimeCover
            index={item.anime.cover_index}
            title={item.anime.title_zh}
            src={item.anime.cover_url}
          />
        </Link>
        <div className="compact-copy">
          <div className="card-kicker">
            {item.anime.year} · {item.anime.format} · {item.anime.episodes} 集
          </div>
          <Link href={`/recommendations/${runId}/${item.anime.mal_id}`}>
            <h3>{item.anime.title_zh}</h3>
          </Link>
          <div className="compact-meta">
            <span className="bangumi-score">
              <Star size={14} weight="fill" aria-hidden />
              Bangumi {item.anime.bangumi_score?.toFixed(1) ?? "暂无"}
            </span>
          </div>
          {matchedTags.length > 0 && (
            <ul
              className="matched-tags card-tags"
              aria-label="命中喜爱作品标签"
            >
              {matchedTags.map((tag) => <li key={tag}>{tag}</li>)}
            </ul>
          )}
        </div>
        <div className="compact-affinity">
          <strong>{item.affinity}</strong>
          <span>亲和度</span>
        </div>
      </article>
    );
  }

  return (
    <article className="recommendation-card">
      <Link
        className="cover-link"
        href={`/recommendations/${runId}/${item.anime.mal_id}`}
      >
        <AnimeCover
          index={item.anime.cover_index}
          title={item.anime.title_zh}
          src={item.anime.cover_url}
        />
        <span className="affinity-stamp">
          <strong>{item.affinity}</strong>
          <small>亲和度</small>
        </span>
      </Link>
      <div className="recommendation-copy">
        <div className="card-kicker">
          {item.anime.year} · {item.anime.format} · {item.anime.episodes} 集
        </div>
        <Link href={`/recommendations/${runId}/${item.anime.mal_id}`}>
          <h3>{item.anime.title_zh}</h3>
        </Link>
        <div className="recommendation-metadata">
          <span className="bangumi-score">
            <Star size={15} weight="fill" aria-hidden />
            Bangumi {item.anime.bangumi_score?.toFixed(1) ?? "暂无"}
          </span>
        </div>
        {matchedTags.length > 0 && (
          <ul
            className="matched-tags card-tags"
            aria-label="命中喜爱作品标签"
          >
            {matchedTags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        )}
      </div>
      <div className="card-actions" aria-label={`${item.anime.title_zh}操作`}>
        <button
          className={feedback === "favorite" ? "selected" : ""}
          disabled={pending !== null}
          onClick={() => {
            const next = feedback === "favorite" ? null : "favorite";
            setFeedback(next);
            if (next && onFeedback) {
              setPending("favorite");
              void onFeedback(next, item.anime.mal_id)
                .catch(() => setFeedback(null))
                .finally(() => setPending(null));
            }
          }}
        >
          <BookmarkSimple
            size={18}
            weight={feedback === "favorite" ? "fill" : "regular"}
          />
          {pending === "favorite"
            ? "保存中…"
            : feedback === "favorite"
              ? "已收藏"
              : "想看"}
        </button>
        <button
          disabled={pending !== null}
          onClick={() => {
            setPending("hide");
            setFeedback("hide");
            if (onFeedback) {
              void onFeedback("hide", item.anime.mal_id)
                .catch(() => setFeedback(null))
                .finally(() => setPending(null));
            }
          }}
        >
          <EyeSlash size={18} />
          {pending === "hide" ? "更新中…" : "不感兴趣"}
        </button>
      </div>
    </article>
  );
}
