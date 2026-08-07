"use client";

import {
  ArrowCounterClockwise,
  BookmarkSimple,
  EyeSlash,
  Star,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useBangumiAnime } from "../lib/bangumi-client";
import type { Recommendation } from "../lib/data";
import { AnimeCover } from "./anime-cover";

const HIDE_UNDO_DELAY_MS = 3200;

export function RecommendationCard({
  item,
  compact = false,
  runId = 31,
  detailHref,
  onOpen,
  onFeedback,
}: {
  item: Recommendation;
  compact?: boolean;
  runId?: number;
  detailHref?: string;
  onOpen?: () => void;
  onFeedback?: (
    action: "favorite" | "hide",
    malId: number,
  ) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<"favorite" | null>(null);
  const [pending, setPending] = useState<"favorite" | null>(null);
  const [hidePhase, setHidePhase] = useState<
    "idle" | "undo" | "committing"
  >("idle");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anime = useBangumiAnime(item.anime) ?? item.anime;
  const animeHref = detailHref ?? `/recommendations/${runId}/${anime.mal_id}`;
  const matchedTags = item.anime.matched_tags?.slice(0, 3) ?? [];

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  function undoHide() {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHidePhase("idle");
  }

  function beginHide() {
    if (hidePhase !== "idle" || pending !== null) return;
    setHidePhase("undo");
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setHidePhase("committing");
      if (!onFeedback) {
        setHidePhase("idle");
        return;
      }
      void onFeedback("hide", anime.mal_id).catch(() => {
        setHidePhase("idle");
      });
    }, HIDE_UNDO_DELAY_MS);
  }

  if (compact) {
    return (
      <article className="recommendation-compact">
        <Link href={animeHref} onClick={onOpen}>
          <AnimeCover
            index={anime.cover_index}
            title={anime.title_zh}
            src={anime.cover_url}
          />
        </Link>
        <div className="compact-copy">
          <div className="card-kicker">
            {anime.year} · {anime.format} · {anime.episodes} 集
          </div>
          <Link href={animeHref} onClick={onOpen}>
            <h3>{anime.title_zh}</h3>
          </Link>
          <div className="compact-meta">
            <span className="bangumi-score">
              <Star size={14} weight="fill" aria-hidden />
              Bangumi {anime.bangumi_score?.toFixed(1) ?? "暂无"}
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
    <article
      className={`recommendation-card${
        hidePhase === "idle" ? "" : " is-hide-pending"
      }`}
    >
      <Link
        className="cover-link"
        href={animeHref}
        onClick={onOpen}
        tabIndex={hidePhase === "idle" ? undefined : -1}
      >
        <AnimeCover
          index={anime.cover_index}
          title={anime.title_zh}
          src={anime.cover_url}
        />
        <span className="affinity-stamp">
          <strong>{item.affinity}</strong>
          <small>亲和度</small>
        </span>
      </Link>
      <div className="recommendation-copy">
        <div className="card-kicker">
          {anime.year} · {anime.format} · {anime.episodes} 集
        </div>
        <Link
          href={animeHref}
          onClick={onOpen}
          tabIndex={hidePhase === "idle" ? undefined : -1}
        >
          <h3>{anime.title_zh}</h3>
        </Link>
        <div className="recommendation-metadata">
          <span className="bangumi-score">
            <Star size={15} weight="fill" aria-hidden />
            Bangumi {anime.bangumi_score?.toFixed(1) ?? "暂无"}
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
      <div className="card-actions" aria-label={`${anime.title_zh}操作`}>
        <button
          className={feedback === "favorite" ? "selected" : ""}
          disabled={pending !== null || hidePhase !== "idle"}
          onClick={() => {
            const next = feedback === "favorite" ? null : "favorite";
            setFeedback(next);
            if (next && onFeedback) {
              setPending("favorite");
              void onFeedback(next, anime.mal_id)
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
          disabled={pending !== null || hidePhase !== "idle"}
          onClick={beginHide}
        >
          <EyeSlash size={18} />
          不感兴趣
        </button>
      </div>
      {hidePhase !== "idle" && (
        <div
          className={`hide-undo-layer${
            hidePhase === "committing" ? " is-committing" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          <span className="hide-undo-icon" aria-hidden>
            <EyeSlash size={28} weight="duotone" />
          </span>
          <strong>
            {hidePhase === "committing"
              ? "正在更新推荐"
              : "已标记不感兴趣"}
          </strong>
          {hidePhase === "undo" && (
            <button
              type="button"
              className="button secondary"
              onClick={undoHide}
            >
              <ArrowCounterClockwise size={18} />
              撤回
            </button>
          )}
        </div>
      )}
    </article>
  );
}
