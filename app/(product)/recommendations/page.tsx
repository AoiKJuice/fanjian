"use client";

import {
  CaretLeft,
  CaretRight,
  Faders,
  GridFour,
  List,
  SortAscending,
} from "@phosphor-icons/react";
import { Dialog } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecommendationCard } from "../../components/recommendation-card";
import { ThemeSelect } from "../../components/theme-select";
import { StatePanel } from "../../components/ui";
import { loadBangumiMetadataMany } from "../../lib/bangumi-client";
import {
  loadRecommendations,
  loadRecommendationRun,
  loadProfiles,
  removeCollectionItem,
  sendRecommendationFeedback,
} from "../../lib/api";
import { recommendationPageItems } from "../../lib/pagination";
import { useActiveProfile } from "../../providers";

const PAGE_SIZE = 20;
const RETURN_STATE_KEY = "fanjian-recommendations-return";
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const CURRENT_YEAR = new Date().getFullYear();

export default function RecommendationsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedRun = Math.max(0, Number(searchParams.get("run")) || 0);
  const requestedPage = Math.max(1, Number(searchParams.get("page")) || 1);
  const restoredRun = useRef(0);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [format, setFormat] = useState("全部");
  const [minimum, setMinimum] = useState(0);
  const [sort, setSort] = useState("推荐分数");
  const [filterRelated, setFilterRelated] = useState(false);
  const [includeShortForm, setIncludeShortForm] = useState(true);
  const [minimumScore, setMinimumScore] = useState(SCORE_MIN);
  const [maximumScore, setMaximumScore] = useState(SCORE_MAX);
  const [minimumYear, setMinimumYear] = useState(0);
  const [maximumYear, setMaximumYear] = useState(0);
  const [currentPage, setCurrentPage] = useState(requestedPage);
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = useActiveProfile(profilesQuery.data);
  const profileId = profile?.id;
  const recommendationsQuery = useQuery({
    queryKey: ["recommendations", profileId, requestedRun || "new"],
    queryFn: async () => {
      if (!requestedRun) return loadRecommendations(profileId!);
      const run = await loadRecommendationRun(requestedRun);
      if (run.profile_id !== profileId) throw new Error("推荐记录不属于当前资料");
      return { items: run.items, runId: run.id, source: "api" as const };
    },
    enabled: Boolean(profileId && profile.rating_count >= 5),
  });
  const { data, isError, isPending } = recommendationsQuery;
  const recommendations = useMemo(() => data?.items ?? [], [data?.items]);
  const yearBounds = useMemo(() => {
    const years = recommendations
      .map((item) => item.anime.year)
      .filter((year) => year > 1900);
    return {
      minimum: years.length ? Math.min(...years) : 1900,
      maximum: years.length ? Math.max(...years) : CURRENT_YEAR,
    };
  }, [recommendations]);
  const selectedMinimumYear = Math.min(
    Math.max(minimumYear || yearBounds.minimum, yearBounds.minimum),
    yearBounds.maximum,
  );
  const selectedMaximumYear = Math.max(
    Math.min(maximumYear || yearBounds.maximum, yearBounds.maximum),
    yearBounds.minimum,
  );
  const scoreFilterActive = minimumScore > SCORE_MIN || maximumScore < SCORE_MAX;
  const yearFilterActive = minimumYear > 0 || maximumYear > 0;
  const bangumiScoresQuery = useQuery({
    queryKey: ["bangumi-filter-scores", data?.runId],
    queryFn: () => loadBangumiMetadataMany(
      recommendations.map((item) => item.anime.mal_id),
    ),
    enabled: scoreFilterActive && recommendations.length > 0,
  });
  const filtered = useMemo(() => {
    const items = recommendations.filter(
      (item) => {
        const metadata = bangumiScoresQuery.data?.get(item.anime.mal_id);
        const score = metadata?.score ?? item.anime.bangumi_score ?? null;
        const scoreMatches = !scoreFilterActive
          || !bangumiScoresQuery.data
          || (score !== null && score >= minimumScore && score <= maximumScore);
        const yearMatches = !yearFilterActive
          || (item.anime.year >= selectedMinimumYear
            && item.anime.year <= selectedMaximumYear);
        return (
          (format === "全部" || item.anime.format === format)
          && item.support >= minimum
          && scoreMatches
          && yearMatches
          && (includeShortForm || !item.anime.is_short_form)
          && (!filterRelated || (!item.anime.is_sequel && !item.anime.is_derivative))
        );
      },
    );
    if (sort === "年份") return [...items].sort((a, b) => b.anime.year - a.anime.year);
    if (sort === "支持人数") return [...items].sort((a, b) => b.support - a.support);
    return items;
  }, [
    bangumiScoresQuery.data,
    filterRelated,
    format,
    includeShortForm,
    maximumScore,
    minimum,
    minimumScore,
    recommendations,
    scoreFilterActive,
    selectedMaximumYear,
    selectedMinimumYear,
    sort,
    yearFilterActive,
  ]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const pageItems = filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);
  const activeFilterCount = Number(format !== "全部")
    + Number(minimum > 0)
    + Number(filterRelated)
    + Number(!includeShortForm)
    + Number(scoreFilterActive)
    + Number(yearFilterActive);

  useEffect(() => {
    if (!data?.runId || restoredRun.current === data.runId) return;
    restoredRun.current = data.runId;
    try {
      const saved = JSON.parse(sessionStorage.getItem(RETURN_STATE_KEY) ?? "null") as
        | { runId: number; page: number; scrollY: number }
        | null;
      if (saved?.runId !== data.runId || saved.page !== activePage) return;
      sessionStorage.removeItem(RETURN_STATE_KEY);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.scrollTo({ top: saved.scrollY, behavior: "auto" });
      }));
    } catch {
      sessionStorage.removeItem(RETURN_STATE_KEY);
    }
  }, [activePage, data?.runId, pageItems.length]);

  const changePage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(nextPage);
    const query = new URLSearchParams(searchParams.toString());
    query.set("page", String(nextPage));
    if (data?.runId) query.set("run", String(data.runId));
    router.replace(`/recommendations?${query.toString()}`, { scroll: false });
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const rememberPosition = () => {
    if (!data?.runId) return;
    sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify({
      runId: data.runId,
      page: activePage,
      scrollY: window.scrollY,
    }));
  };

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
            onValueChange={(value) => { setSort(value); setCurrentPage(1); }}
          />
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button className="button secondary">
                <Faders size={18} /> 筛选
                {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
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
                    {[
                      { value: "全部", label: "全部" },
                      { value: "TV", label: "TV" },
                      { value: "MOVIE", label: "电影" },
                      { value: "OVA", label: "OVA" },
                      { value: "ONA", label: "ONA" },
                    ].map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={format === option.value ? "active" : ""}
                        onClick={() => { setFormat(option.value); setCurrentPage(1); }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Bangumi 评分</legend>
                  <div className="filter-range-values">
                    <strong>{minimumScore.toFixed(1)}</strong>
                    <span>至</span>
                    <strong>{maximumScore.toFixed(1)}</strong>
                    {scoreFilterActive && bangumiScoresQuery.isPending && (
                      <strong className="filter-status">正在读取评分</strong>
                    )}
                  </div>
                  <div className="dual-range-control">
                    <label>
                      <span>最低</span>
                      <input
                        type="range"
                        min={SCORE_MIN}
                        max={SCORE_MAX}
                        step="0.1"
                        value={minimumScore}
                        onChange={(event) => {
                          setMinimumScore(Math.min(Number(event.target.value), maximumScore));
                          setCurrentPage(1);
                        }}
                      />
                    </label>
                    <label>
                      <span>最高</span>
                      <input
                        type="range"
                        min={SCORE_MIN}
                        max={SCORE_MAX}
                        step="0.1"
                        value={maximumScore}
                        onChange={(event) => {
                          setMaximumScore(Math.max(Number(event.target.value), minimumScore));
                          setCurrentPage(1);
                        }}
                      />
                    </label>
                  </div>
                </fieldset>
                <fieldset>
                  <legend>发行年份</legend>
                  <div className="filter-range-values">
                    <strong>{selectedMinimumYear}</strong>
                    <span>至</span>
                    <strong>{selectedMaximumYear}</strong>
                  </div>
                  <div className="dual-range-control">
                    <label>
                      <span>最早</span>
                      <input
                        type="range"
                        min={yearBounds.minimum}
                        max={yearBounds.maximum}
                        step="1"
                        value={selectedMinimumYear}
                        onChange={(event) => {
                          setMinimumYear(Math.min(Number(event.target.value), selectedMaximumYear));
                          setCurrentPage(1);
                        }}
                      />
                    </label>
                    <label>
                      <span>最晚</span>
                      <input
                        type="range"
                        min={yearBounds.minimum}
                        max={yearBounds.maximum}
                        step="1"
                        value={selectedMaximumYear}
                        onChange={(event) => {
                          setMaximumYear(Math.max(Number(event.target.value), selectedMinimumYear));
                          setCurrentPage(1);
                        }}
                      />
                    </label>
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
                      onChange={(event) => { setMinimum(Number(event.target.value)); setCurrentPage(1); }}
                    />
                    <span>{minimum || "不限"} 人</span>
                  </label>
                </fieldset>
                <fieldset>
                  <legend>内容时长</legend>
                  <label className="filter-check">
                    <input
                      type="checkbox"
                      checked={includeShortForm}
                      onChange={(event) => {
                        setIncludeShortForm(event.target.checked);
                        setCurrentPage(1);
                      }}
                    />
                    <span>包含泡面番</span>
                  </label>
                </fieldset>
                <fieldset>
                  <legend>系列关系</legend>
                  <button
                    type="button"
                    className={`filter-option-toggle${filterRelated ? " active" : ""}`}
                    aria-pressed={filterRelated}
                    onClick={() => { setFilterRelated((value) => !value); setCurrentPage(1); }}
                  >
                    过滤续作、衍生作
                  </button>
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
        <>
          <div className={view === "grid" ? "recommendation-grid" : "recommendation-list"}>
            {pageItems.map((item) => (
              <RecommendationCard
                key={`${data?.runId}-${item.anime.mal_id}`}
                item={item}
                compact={view === "list"}
                runId={data?.runId}
                detailHref={`/recommendations/${data?.runId}/${item.anime.mal_id}?fromPage=${activePage}`}
                onOpen={rememberPosition}
                onFeedback={handleFeedback}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <nav className="pagination" aria-label="推荐分页">
              <button type="button" aria-label="上一页" disabled={activePage === 1} onClick={() => changePage(activePage - 1)}>
                <CaretLeft size={19} />
              </button>
              <div className="pagination-pages">
                {recommendationPageItems(activePage, totalPages).map((item, index) => item === "ellipsis" ? (
                  <span key={`ellipsis-${index}`} aria-hidden="true">···</span>
                ) : (
                  <button
                    type="button"
                    key={item}
                    className={item === activePage ? "active" : ""}
                    aria-label={`第 ${item} 页`}
                    aria-current={item === activePage ? "page" : undefined}
                    onClick={() => changePage(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button type="button" aria-label="下一页" disabled={activePage === totalPages} onClick={() => changePage(activePage + 1)}>
                <CaretRight size={19} />
              </button>
            </nav>
          )}
        </>
      ) : (
        <StatePanel
          title="当前筛选没有结果"
        />
      )}
    </div>
  );
}
