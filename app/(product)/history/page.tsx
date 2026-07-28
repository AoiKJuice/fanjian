"use client";

import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  ClockCounterClockwise,
  Trash,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, StatePanel } from "../../components/ui";
import {
  deleteRecommendationRun,
  loadProfiles,
  loadRecommendationHistory,
  type RecommendationHistoryItem,
} from "../../lib/api";

export default function HistoryPage() {
  const [runs, setRuns] = useState<RecommendationHistoryItem[]>([]);
  const [compare, setCompare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadProfiles()
      .then(async (profiles) => {
        if (profiles[0]) {
          setRuns(await loadRecommendationHistory(profiles[0].id));
        }
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  async function remove(runId: number) {
    try {
      await deleteRecommendationRun(runId);
      setRuns((items) => items.filter((item) => item.id !== runId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="历史"
        actions={
          <button
            className="button secondary"
            disabled={runs.length < 2}
            onClick={() => setCompare(!compare)}
          >
            <ArrowsLeftRight size={18} /> {compare ? "退出对比" : "标记最近两次"}
          </button>
        }
      />
      {error && <p className="inline-note" role="alert">{error}</p>}
      {loading ? (
        <StatePanel title="正在读取推荐历史" />
      ) : !runs.length ? (
        <StatePanel
          title="还没有推荐历史"
          action={{ label: "生成推荐", href: "/recommendations" }}
        />
      ) : (
        <div className="history-list">
          {runs.map((run, index) => (
            <article
              key={run.id}
              className={compare && index < 2 ? "compare-selected" : ""}
            >
              <div className="history-date">
                <ClockCounterClockwise size={23} weight="duotone" />
                <div>
                  <strong>{new Date(run.created_at).toLocaleString("zh-CN")}</strong>
                  <span>运行 #{run.id}</span>
                </div>
              </div>
              <div className="history-stat">
                <strong>{run.item_count}</strong><span>推荐数量</span>
              </div>
              <div className="history-stat">
                <strong>{run.status === "ready" ? "完成" : "不足"}</strong>
                <span>运行状态</span>
              </div>
              <div className="history-model">
                <strong>{run.model_version}</strong>
                <span>{run.data_version}</span>
              </div>
              <span className={`status-label ${index === 0 ? "current" : ""}`}>
                {index === 0 ? "最新" : "历史"}
              </span>
              <div className="history-actions">
                <Link
                  className="icon-button"
                  aria-label={`重新打开运行 ${run.id}`}
                  href={`/recommendations?run=${run.id}`}
                >
                  <ArrowCounterClockwise size={18} />
                </Link>
                <button
                  className="icon-button danger"
                  aria-label={`删除运行 ${run.id}`}
                  onClick={() => void remove(run.id)}
                >
                  <Trash size={18} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {compare && runs.length >= 2 && (
        <section className="comparison-panel">
          <p className="eyebrow">#{runs[0].id} 对比 #{runs[1].id}</p>
          <h2>最近两次真实运行</h2>
          <div className="comparison-grid">
            <div>
              <strong>{runs[0].item_count - runs[1].item_count}</strong>
              <span>推荐数量变化</span>
            </div>
            <div>
              <strong>{runs[0].model_version === runs[1].model_version ? "相同" : "变化"}</strong>
              <span>模型版本</span>
            </div>
            <div>
              <strong>{runs[0].data_version === runs[1].data_version ? "相同" : "变化"}</strong>
              <span>数据版本</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
