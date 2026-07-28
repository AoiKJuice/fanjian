"use client";

import {
  ArrowLeft,
  BookmarkSimple,
  ChartBar,
  EyeSlash,
  Star,
  CaretDown,
  CaretUp,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AnimeCover } from "../../../../components/anime-cover";
import { StatePanel } from "../../../../components/ui";
import {
  loadCollections,
  loadRecommendationRun,
  removeCollectionItem,
  sendRecommendationFeedback,
} from "../../../../lib/api";

export default function RecommendationDetailPage() {
  const params = useParams<{ runId: string; malId: string }>();
  const runId = Number(params.runId);
  const malId = Number(params.malId);
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [pendingCollection, setPendingCollection] = useState<
    "favorites" | "hidden" | null
  >(null);
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
    }
  }

  if (runQuery.isPending) {
    return <div className="page"><StatePanel title="正在读取推荐证据" /></div>;
  }
  if (runQuery.isError || !item) {
    return (
      <div className="page">
        <StatePanel
          title="这条推荐不存在"
          action={{ label: "返回推荐", href: "/recommendations" }}
        />
      </div>
    );
  }
  const total = Object.values(item.neighbor_distribution).reduce(
    (sum, count) => sum + count,
    0,
  );
  const synopsis = item.anime.synopsis || "暂未提供内容简介。";
  const synopsisCanFold = synopsis.length > 90;

  return (
    <div className="page detail-page">
      <Link className="back-link" href="/recommendations">
        <ArrowLeft size={17} /> 返回推荐 #{runId}
      </Link>
      <section className="detail-hero">
        <AnimeCover
          index={item.anime.cover_index}
          title={item.anime.title_zh}
          src={item.anime.cover_url}
          priority
        />
        <div className="detail-copy">
          <p className="eyebrow">{item.anime.year} · {item.anime.format} · {item.anime.episodes} 集</p>
          <h1>{item.anime.title_zh}</h1>
          <p className="native-title">{item.anime.title_native} · {item.anime.title_en}</p>
          <div className="detail-metadata">
            <span className="bangumi-score">
              <Star size={16} weight="fill" aria-hidden />
              Bangumi {item.anime.bangumi_score?.toFixed(1) ?? "暂无"}
            </span>
            {(item.anime.matched_tags?.length ?? 0) > 0 && (
              <ul className="matched-tags" aria-label="命中喜爱作品标签">
                {item.anime.matched_tags?.slice(0, 3).map((tag) => (
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
              disabled={pendingCollection !== null}
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
              className={`button secondary${isHidden ? " collection-active" : ""}`}
              aria-pressed={isHidden}
              disabled={pendingCollection !== null}
              onClick={() => void toggleCollection("hidden")}
            >
              <EyeSlash size={18} weight={isHidden ? "fill" : "regular"} />
              {pendingCollection === "hidden"
                ? "保存中…"
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
    </div>
  );
}
