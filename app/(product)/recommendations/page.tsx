"use client";

import {
  Faders,
  GridFour,
  List,
  SortAscending,
} from "@phosphor-icons/react";
import { Dialog } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { RecommendationCard } from "../../components/recommendation-card";
import { ThemeSelect } from "../../components/theme-select";
import { StatePanel } from "../../components/ui";
import {
  loadRecommendations,
  loadProfiles,
  removeCollectionItem,
  sendRecommendationFeedback,
} from "../../lib/api";
import { useActiveProfile } from "../../providers";

export default function RecommendationsPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [format, setFormat] = useState("全部");
  const [minimum, setMinimum] = useState(0);
  const [sort, setSort] = useState("推荐分数");
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = useActiveProfile(profilesQuery.data);
  const profileId = profile?.id;
  const recommendationsQuery = useQuery({
    queryKey: ["recommendations", profileId],
    queryFn: () => loadRecommendations(profileId!),
    enabled: Boolean(profileId && profile.rating_count >= 5),
  });
  const { data, isError, isPending } = recommendationsQuery;
  const recommendations = useMemo(() => data?.items ?? [], [data?.items]);
  const filtered = useMemo(() => {
    const items = recommendations.filter(
      (item) =>
        (format === "全部" || item.anime.format === format) &&
        item.support >= minimum,
    );
    if (sort === "年份") return [...items].sort((a, b) => b.anime.year - a.anime.year);
    if (sort === "支持人数") return [...items].sort((a, b) => b.support - a.support);
    return items;
  }, [format, minimum, recommendations, sort]);

  const handleFeedback = useCallback(
    async (action: "favorite" | "hide", malId: number) => {
      if (!data) return;
      await sendRecommendationFeedback(data.runId, malId, action);
      if (action === "hide") {
        const refreshed = await recommendationsQuery.refetch();
        if (refreshed.error) {
          if (profileId) {
            await removeCollectionItem(
              profileId,
              "hidden",
              malId,
            ).catch(() => undefined);
          }
          throw refreshed.error;
        }
      }
      void queryClient.invalidateQueries({
        queryKey: ["profile-collections", profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["dashboard-recommendations", profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["recommendation-history", profileId],
      });
    },
    [data, profileId, queryClient, recommendationsQuery],
  );

  return (
    <div className="page recommendations-page">
      <div className="recommendation-toolbar">
        <div className="segmented" aria-label="视图切换">
          <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-pressed={view === "grid"}>
            <GridFour size={18} /> 网格
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-pressed={view === "list"}>
            <List size={18} /> 列表
          </button>
        </div>
        <div className="toolbar-right">
          <ThemeSelect
            value={sort}
            ariaLabel="排序"
            icon={<SortAscending size={18} aria-hidden />}
            options={[
              { value: "推荐分数", label: "推荐分数" },
              { value: "年份", label: "年份" },
              { value: "支持人数", label: "支持人数" },
            ]}
            onValueChange={setSort}
          />
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button className="button secondary">
                <Faders size={18} /> 筛选
                {(format !== "全部" || minimum > 0) && <span className="filter-count">1</span>}
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="filter-drawer" aria-describedby={undefined}>
                <div className="drawer-heading">
                  <Dialog.Title>筛选</Dialog.Title>
                  <Dialog.Close className="button quiet">完成</Dialog.Close>
                </div>
                <fieldset>
                  <legend>作品格式</legend>
                  <div className="choice-grid">
                    {["全部", "TV", "电影", "OVA", "ONA"].map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={format === value ? "active" : ""}
                        onClick={() => setFormat(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>最低相似观众支持</legend>
                  <label className="range-control">
                    <input
                      type="range"
                      min="0"
                      max="20"
                      step="5"
                      value={minimum}
                      onChange={(event) => setMinimum(Number(event.target.value))}
                    />
                    <span>{minimum || "不限"} 人</span>
                  </label>
                </fieldset>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {profilesQuery.isPending || (profile?.rating_count && isPending) ? (
        <StatePanel
          title="正在生成推荐"
        />
      ) : profile && profile.rating_count < 5 ? (
        <StatePanel
          title="至少录入 5 条有效评分"
          action={{ label: "导入或手动评分", href: "/onboarding" }}
        />
      ) : profilesQuery.isError || isError ? (
        <StatePanel
          title="推荐暂时不可用"
        />
      ) : filtered.length ? (
        <div className={view === "grid" ? "recommendation-grid" : "recommendation-list"}>
          {filtered.map((item) => (
            <RecommendationCard
              key={`${data?.runId}-${item.anime.mal_id}`}
              item={item}
              compact={view === "list"}
              runId={data?.runId}
              onFeedback={handleFeedback}
            />
          ))}
        </div>
      ) : (
        <StatePanel
          title="当前筛选没有结果"
        />
      )}
    </div>
  );
}
