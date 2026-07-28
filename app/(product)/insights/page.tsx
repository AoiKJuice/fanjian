"use client";

import {
  ChartLineUp,
  Compass,
  Eye,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Metric, PageHeader, StatePanel } from "../../components/ui";
import { loadInsights, loadProfiles } from "../../lib/api";

const InsightsChart = dynamic(
  () =>
    import("../../components/insights-chart").then(
      (module) => module.InsightsChart,
    ),
);

export default function InsightsPage() {
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
  const insights = insightsQuery.data;

  if (profilesQuery.isPending || insightsQuery.isPending) {
    return (
      <div className="page">
        <StatePanel title="正在计算审美分析" />
      </div>
    );
  }
  if (!profile || !insights || profilesQuery.isError || insightsQuery.isError) {
    return (
      <div className="page">
        <StatePanel title="无法生成审美分析" />
      </div>
    );
  }

  const commonScore = Object.entries(insights.histogram).sort(
    (left, right) => right[1] - left[1],
  )[0]?.[0];

  return (
    <div className="page insights-page">
      <PageHeader
        title="审美分析"
      />
      <div className="metric-strip">
        <Metric value={String(insights.mean_rating)} label="平均评分" />
        <Metric value={String(insights.rating_stddev)} label="标准差" />
        <Metric value={`${insights.long_tail_ratio}%`} label="长尾观看比例" />
        <Metric value={String(insights.neighbor_count)} label="正相似邻居" />
      </div>

      <div className="insight-grid">
        <section className="section-block insight-wide">
          <div className="section-heading">
            <div>
              <p className="eyebrow">评分分布</p>
              <h2>{commonScore ? `${commonScore} 分是当前最常用评价` : "还没有有效评分"}</h2>
            </div>
            <ChartLineUp size={25} weight="duotone" />
          </div>
          <InsightsChart histogram={insights.histogram} />
          <details className="table-alternative">
            <summary>查看表格数据</summary>
            <table>
              <tbody>
                <tr>
                  <th>评分</th>
                  {Object.keys(insights.histogram).map((score) => <td key={score}>{score}</td>)}
                </tr>
                <tr>
                  <th>数量</th>
                  {Object.entries(insights.histogram).map(([score, count]) => <td key={score}>{count}</td>)}
                </tr>
              </tbody>
            </table>
          </details>
        </section>

        <section className="section-block signal-card">
          <div className="signal-card-heading">
            <p className="eyebrow">主流倾向指数</p>
            <Compass size={26} weight="duotone" />
          </div>
          <div className="signal-card-body">
            <strong>{insights.mainstream_index}</strong>
            <h2>{insights.mainstream_index >= 67 ? "观看较集中于高关注作品" : insights.mainstream_index <= 33 ? "观看较偏长尾" : "主流与长尾较均衡"}</h2>
          </div>
        </section>

        <section className="section-block signal-card">
          <div className="signal-card-heading">
            <p className="eyebrow">资料区分度</p>
            <Eye size={26} weight="duotone" />
          </div>
          <div className="signal-card-body">
            <h2>{insights.quality}质量评分资料</h2>
          </div>
        </section>
      </div>
    </div>
  );
}
