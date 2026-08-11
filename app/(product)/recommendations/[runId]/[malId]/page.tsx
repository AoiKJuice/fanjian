"use client";

import {
  ArrowCounterClockwise,
  ArrowLeft,
  BookmarkSimple,
  ChartBar,
  EyeSlash,
  Star,
  CaretDown,
  CaretUp,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimeCover } from "../../../../components/anime-cover";
import { AnimeCommunity } from "../../../../components/anime-community";
import { StatePanel } from "../../../../components/ui";
import { useBangumiAnime } from "../../../../lib/bangumi-client";
import {
  loadCollections,
  loadRecommendations,
  loadRecommendationRun,
  removeCollectionItem,
  sendRecommendationFeedback,
} from "../../../../lib/api";

const HIDE_UNDO_DELAY_MS = 3200;

export default function RecommendationDetailPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams<{ runId: string; malId: string }>();
  const runId = Number(params.runId);
  const malId = Number(params.malId);
  const fromPage = Math.max(1, Number(searchParams.get("fromPage")) || 1);
  const returnHref = `/recommendations?run=${runId}&page=${fromPage}`;
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [pendingCollection, setPendingCollection] = useState<
    "favorites" | "hidden" | null
  >(null);
  const [hidePhase, setHidePhase] = useState<
    "idle" | "undo" | "committing"
  >("idle");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const runQuery = useQuery({
    queryKey: ["recommendation-run", runId],
    queryFn: () => loadRecommendationRun(runId),
    enabled: Number.isFinite(runId),
  });
  const profileId = runQuery.data?.profile_id;
  const collectionsQuery = useQuery({
    queryKey: ["profile-collections", profileId],
    queryFn: () => loadCollections(profileId!),
    enabled: Boolean(profileId),
  });
  const item = runQuery.data?.items.find(
    (candidate) => candidate.anime.mal_id === malId,
  );
  const anime = useBangumiAnime(item?.anime);
  const isFavorite = Boolean(
    collectionsQuery.data?.favorites.some(
      (entry) => entry.mal_id === malId,
    ),
  );
  const isHidden = Boolean(
    collectionsQuery.data?.hidden.some(
      (entry) => entry.mal_id === malId,
    ),
  );

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
    if (hidePhase !== "idle" || pendingCollection) return;
    setHidePhase("undo");
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setHidePhase("committing");
      void toggleCollection("hidden");
    }, HIDE_UNDO_DELAY_MS);
  }

  async function toggleCollection(
    collection: "favorites" | "hidden",
  ) {
    if (!profileId || pendingCollection) return;
    const active = collection === "favorites" ? isFavorite : isHidden;
    setPendingCollection(collection);
    setActionMessage("");
    setActionError(false);
    try {
      if (active) {
        await removeCollectionItem(profileId, collection, malId);
      } else {
        await sendRecommendationFeedback(
          runId,
          malId,
          collection === "favorites" ? "favorite" : "hide",
        );
      }
      await collectionsQuery.refetch();
      if (collection === "hidden" && !active) {
        const refreshed = await loadRecommendations(profileId);
        queryClient.setQueryData(
          ["recommendations", profileId],
          refreshed,
        );
        void queryClient.invalidateQueries({
          queryKey: ["dashboard-recommendations", profileId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["recommendation-history", profileId],
        });
        router.push(returnHref);
        return;
      }
      setActionMessage(
        collection === "favorites"
          ? active
            ? "已移出想看"
            : "已保存到想看"
          : active
            ? "已取消忽略"
            : "已加入不感兴趣",
      );
    } catch {
      setActionError(true);
      setActionMessage("保存失败，请重试");
    } finally {
      setPendingCollection(null);
      if (collection === "hidden") setHidePhase("idle");
    }
  }

  if (runQuery.isPending) {
    return <div className="page"><StatePanel title="正在读取推荐证据" /></div>;
  }
  if (runQuery.isError || !item || !anime) {
    return (
      <div className="page">
        <StatePanel
          title="这条推荐不存在"
          action={{ label: "返回推荐", href: returnHref }}
        />
      </div>
    );
  }
  const total = Object.values(item.neighbor_distribution).reduce(
    (sum, count) => sum + count,
    0,
  );
  const synopsis = anime.synopsis || "暂未提供内容简介。";
  const synopsisCanFold = synopsis.length > 90;

  return (
    <div className="page detail-page">
      <Link className="back-link" href={returnHref}>
        <ArrowLeft size={17} /> 返回推荐 #{runId}
      </Link>
      <section className="detail-hero">
        <AnimeCover
          index={anime.cover_index}
          title={anime.title_zh}
          src={anime.cover_url}
          priority
        />
        <div className="detail-copy">
          <p className="eyebrow">{anime.year} · {anime.format} · {anime.episodes} 集</p>
          <h1>{anime.title_zh}</h1>
          <p className="native-title">{anime.title_native} · {anime.title_en}</p>
          <div className="detail-metadata">
            <span className="bangumi-score">
              <Star size={16} weight="fill" aria-hidden />
              Bangumi {anime.bangumi_score?.toFixed(1) ?? "暂无"}
            </span>
            {(anime.matched_tags?.length ?? 0) > 0 && (
              <ul className="matched-tags" aria-label="命中喜爱作品标签">
                {anime.matched_tags?.slice(0, 3).map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="synopsis-block">
            <p
              className={`synopsis ${synopsisExpanded ? "expanded" : "collapsed"}`}
              id="recommendation-synopsis"
            >
              {synopsis}
            </p>
            {synopsisCanFold && (
              <button
                type="button"
                className="synopsis-toggle"
                aria-expanded={synopsisExpanded}
                aria-controls="recommendation-synopsis"
                onClick={() => setSynopsisExpanded((current) => !current)}
              >
                {synopsisExpanded ? (
                  <><CaretUp size={16} aria-hidden /> 收起简介</>
                ) : (
                  <><CaretDown size={16} aria-hidden /> 展开简介</>
                )}
              </button>
            )}
          </div>
          <div className="detail-actions">
            <button
              className={`button secondary${isFavorite ? " collection-active" : ""}`}
              aria-pressed={isFavorite}
              disabled={pendingCollection !== null || hidePhase !== "idle"}
              onClick={() => void toggleCollection("favorites")}
            >
              <BookmarkSimple
                size={18}
                weight={isFavorite ? "fill" : "regular"}
              />
              {pendingCollection === "favorites"
                ? "保存中…"
                : isFavorite
                  ? "已想看"
                  : "想看"}
            </button>
            <button
              className={`button secondary${
                isHidden || hidePhase === "undo"
                  ? " collection-active"
                  : ""
              }`}
              aria-pressed={isHidden || hidePhase === "undo"}
              disabled={
                pendingCollection !== null || hidePhase === "committing"
              }
              onClick={() => {
                if (hidePhase === "undo") {
                  undoHide();
                } else if (isHidden) {
                  void toggleCollection("hidden");
                } else {
                  beginHide();
                }
              }}
            >
              {hidePhase === "undo" ? (
                <ArrowCounterClockwise size={18} />
              ) : (
                <EyeSlash
                  size={18}
                  weight={isHidden ? "fill" : "regular"}
                />
              )}
              {hidePhase === "undo"
                ? "撤回"
                : pendingCollection === "hidden" ||
                    hidePhase === "committing"
                ? "更新中…"
                : isHidden
                  ? "已忽略"
                  : "不感兴趣"}
            </button>
          </div>
          {actionMessage && (
            <p
              className={`action-feedback${actionError ? " error" : ""}`}
              role={actionError ? "alert" : "status"}
            >
              {actionMessage}
            </p>
          )}
        </div>
        <div className="affinity-panel">
          <span className="eyebrow">预测亲和度</span>
          <strong>{item.affinity}</strong>
        </div>
      </section>

      <div className="detail-columns">
        <section className="section-block">
          <div className="section-heading">
            <h2>相似作品</h2>
          </div>
          <ol className="evidence-list">
            {item.evidence.map((entry, index) => (
              <li key={entry.mal_id}>
                <span className="evidence-rank">{String(index + 1).padStart(2, "0")}</span>
                <strong>{entry.title}</strong>
              </li>
            ))}
          </ol>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <h2>同好们评分</h2>
            <ChartBar size={24} weight="duotone" />
          </div>
          <div className="distribution-bars">
            {Object.entries(item.neighbor_distribution).map(([label, count]) => (
              <div key={label}>
                <span>{label} 分</span>
                <div><i style={{ width: `${total ? (count / total) * 100 : 0}%` }} /></div>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
      <AnimeCommunity malId={anime.mal_id} title={anime.title_zh} />
    </div>
  );
}
