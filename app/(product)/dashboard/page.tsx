"use client";

import {
  ArrowRight,
  CheckCircle,
  Clock,
  Sparkle,
  TrendUp,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { RecommendationCard } from "../../components/recommendation-card";
import { Metric, PageHeader, StatePanel } from "../../components/ui";
import {
  loadInsights,
  loadModelCard,
  loadProfiles,
  loadRecommendations,
} from "../../lib/api";

export default function DashboardPage() {
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = profilesQuery.data?.[0];
  const insightsQuery = useQuery({
    queryKey: ["insights", profile?.id],
    queryFn: () => loadInsights(profile!.id),
    enabled: Boolean(profile),
  });
  const recommendationsQuery = useQuery({
    queryKey: ["dashboard-recommendations", profile?.id],
    queryFn: () => loadRecommendations(profile!.id),
    enabled: Boolean(profile && profile.rating_count >= 5),
  });
  const modelQuery = useQuery({
    queryKey: ["model-card"],
    queryFn: loadModelCard,
  });

  if (profilesQuery.isPending) {
    return (
      <div className="page">
        <StatePanel
          title="正在读取本地资料"
        />
      </div>
    );
  }
  if (profilesQuery.isError || !profile) {
    return (
      <div className="page">
        <StatePanel
          title="本地资料不可用"
        />
      </div>
    );
  }

  const insights = insightsQuery.data;
  const recommendations = recommendationsQuery.data?.items ?? [];
  const needsRatings = profile.rating_count < 5;
  return (
    <div className="page dashboard-page">
      <PageHeader
        title={profile.name}
        actions={
          <Link
            className="button primary"
            href={needsRatings ? "/onboarding?step=rate" : "/recommendations"}
          >
            <Sparkle size={18} weight="fill" />
            {needsRatings ? "录入评分" : "生成新推荐"}
          </Link>
        }
      />

      <section className="dashboard-lead">
        <div className="profile-score">
          <div
            className="score-orbit"
            aria-label={`资料质量${insights?.quality ?? "读取中"}`}
          >
            <span>{insights?.quality ?? "…"}</span>
          </div>
          <div>
            <h2>
              {needsRatings
                ? "评分数量不足"
                : insights?.quality === "高"
                  ? "评分资料适合生成推荐"
                  : "可以生成推荐，增加评分会改善匹配"}
            </h2>
            <Link className="text-link" href="/library">
              管理评分 <ArrowRight size={17} />
            </Link>
          </div>
        </div>
        <div className="metric-row">
          <Metric
            value={String(profile.rating_count)}
            label="有效评分"
          />
          <Metric
            value={String(insights?.rating_stddev ?? "…")}
            label="评分标准差"
          />
          <Metric
            value={String(insights?.neighbor_count ?? "…")}
            label="可用邻居"
          />
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>当前推荐</h2>
          <Link className="text-link" href="/recommendations">
            查看推荐页 <ArrowRight size={17} />
          </Link>
        </div>
        {needsRatings ? (
          <StatePanel
            title="至少录入 5 条有效评分"
          />
        ) : recommendationsQuery.isPending ? (
          <StatePanel
            title="正在生成推荐"
          />
        ) : recommendationsQuery.isError ? (
          <StatePanel
            title="推荐生成失败"
          />
        ) : recommendations.length ? (
          <div className="compact-list">
            {recommendations.slice(0, 3).map((item) => (
              <RecommendationCard
                key={item.anime.mal_id}
                item={item}
                compact
                runId={recommendationsQuery.data?.runId}
              />
            ))}
          </div>
        ) : (
          <StatePanel
            title="当前没有足够候选"
          />
        )}
      </section>

      <div className="dashboard-columns">
        <section className="section-block distribution-panel">
          <div className="section-heading">
            <h2>评分分布</h2>
            <TrendUp size={24} weight="duotone" aria-hidden />
          </div>
          <div className="mini-histogram" aria-label="评分分布">
            {Array.from({ length: 10 }, (_, index) => {
              const values = Object.values(insights?.histogram ?? {});
              const maximum = Math.max(...values, 1);
              const count = insights?.histogram[String(index + 1)] ?? 0;
              return (
                <div key={index}>
                  <span style={{ height: `${(count / maximum) * 100}%` }} />
                  <small>{index + 1}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className="section-block activity-panel">
          <div className="section-heading">
            <h2>真实数据索引</h2>
            <Clock size={24} weight="duotone" aria-hidden />
          </div>
          <ul className="activity-list">
            <li>
              <CheckCircle size={18} weight="fill" />
              <span>
                <strong>{modelQuery.data?.catalog_items ?? "…"}</strong>{" "}
                部作品在本地目录
              </span>
            </li>
            <li>
              <CheckCircle size={18} weight="fill" />
              <span>
                <strong>{modelQuery.data?.training_users ?? "…"}</strong>{" "}
                名训练用户
              </span>
            </li>
            <li>
              <CheckCircle size={18} weight="fill" />
              <span>
                模型：<strong>{modelQuery.data?.algorithm ?? "读取中"}</strong>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
