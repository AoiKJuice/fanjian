"use client";

import {
  ArrowCounterClockwise,
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
import {
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RecommendationCard } from "../../components/recommendation-card";
import { ThemeSelect } from "../../components/theme-select";
import { StatePanel } from "../../components/ui";
import {
  loadRecommendations,
  loadRecommendationRun,
  loadProfiles,
  recommendationFilterRecord,
  type RecommendationFilters,
  removeCollectionItem,
  sendRecommendationFeedback,
} from "../../lib/api";
import { recommendationPageItems } from "../../lib/pagination";
import { useActiveProfile } from "../../providers";

const PAGE_SIZE = 20;
const RETURN_STATE_KEY = "fanjian-recommendations-return";
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const DEFAULT_MINIMUM_SCORE = 7;
const YEAR_MIN = 2000;
const YEAR_MAX = 2027;

type RememberedFilterState = {
  format: string;
  minimumSupport: number;
  filterRelated: boolean;
  includeShortForm: boolean;
  scoreFilterEnabled: boolean;
  minimumScore: number;
  yearFilterEnabled: boolean;
  minimumYear: number;
  maximumYear: number;
};

const FILTER_QUERY_KEYS = ["format", "support", "related", "short", "score", "year"];
let rememberedFilterState: RememberedFilterState | null = null;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function numericParam(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function initialFilterState(searchParams: URLSearchParams): RememberedFilterState {
  const hasExplicitFilters = FILTER_QUERY_KEYS.some((key) => searchParams.has(key));
  if (!hasExplicitFilters && rememberedFilterState) return rememberedFilterState;
  const initialYear = (searchParams.get("year") ?? "").split("-");
  return {
    format: searchParams.get("format") || "全部",
    minimumSupport: clamp(numericParam(searchParams.get("support"), 0), 0, 20),
    filterRelated: searchParams.get("related") === "1",
    includeShortForm: searchParams.get("short") !== "0",
    scoreFilterEnabled: searchParams.has("score"),
    minimumScore: clamp(
      numericParam(searchParams.get("score"), DEFAULT_MINIMUM_SCORE),
      SCORE_MIN,
      SCORE_MAX,
    ),
    yearFilterEnabled: searchParams.has("year"),
    minimumYear: clamp(
      numericParam(initialYear[0] || null, YEAR_MIN),
      YEAR_MIN,
      YEAR_MAX,
    ),
    maximumYear: clamp(
      numericParam(initialYear[1] || null, YEAR_MAX),
      YEAR_MIN,
      YEAR_MAX,
    ),
  };
}

function runMatchesFilters(filters: string | undefined, expected: object) {
  if (!filters) return false;
  try {
    const saved = JSON.parse(filters) as Record<string, unknown>;
    const normalized = {
      limit: Number(saved.limit) || 100,
      min_support: Number(saved.min_support) || 5,
      allow_sequels: saved.allow_sequels !== false,
      formats: Array.isArray(saved.formats) ? saved.formats : [],
      minimum_bangumi_score: saved.minimum_bangumi_score ?? null,
      minimum_year: saved.minimum_year ?? null,
      maximum_year: saved.maximum_year ?? null,
      include_short_form: saved.include_short_form !== false,
      exclude_related: saved.exclude_related === true,
    };
    return JSON.stringify(normalized) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export default function RecommendationsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedRun = Math.max(0, Number(searchParams.get("run")) || 0);
  const requestedPage = Math.max(1, Number(searchParams.get("page")) || 1);
  const restoredRun = useRef(0);
  const initialFilters = useRef(initialFilterState(
    new URLSearchParams(searchParams.toString()),
  )).current;
  const [view, setView] = useState<"grid" | "list">(
    searchParams.get("view") === "list" ? "list" : "grid",
  );
  const [format, setFormat] = useState(initialFilters.format);
  const [minimum, setMinimum] = useState(initialFilters.minimumSupport);
  const [sort, setSort] = useState(searchParams.get("sort") || "推荐分数");
  const [filterRelated, setFilterRelated] = useState(initialFilters.filterRelated);
  const [includeShortForm, setIncludeShortForm] = useState(initialFilters.includeShortForm);
  const [scoreFilterEnabled, setScoreFilterEnabled] = useState(
    initialFilters.scoreFilterEnabled,
  );
  const [minimumScore, setMinimumScore] = useState(initialFilters.minimumScore);
  const [yearFilterEnabled, setYearFilterEnabled] = useState(
    initialFilters.yearFilterEnabled,
  );
  const [minimumYear, setMinimumYear] = useState(initialFilters.minimumYear);
  const [maximumYear, setMaximumYear] = useState(initialFilters.maximumYear);
  const [currentPage, setCurrentPage] = useState(requestedPage);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState<RecommendationFilters>(() => ({
    format,
    minimumSupport: minimum,
    minimumBangumiScore: scoreFilterEnabled ? minimumScore : null,
    minimumYear: yearFilterEnabled ? minimumYear : null,
    maximumYear: yearFilterEnabled ? maximumYear : null,
    includeShortForm,
    excludeRelated: filterRelated,
  }));
  const filterRecord = useMemo(
    () => recommendationFilterRecord(appliedFilters),
    [appliedFilters],
  );
  const filterKey = JSON.stringify(filterRecord);

  const replaceQuery = useCallback((
    update: (query: URLSearchParams) => void,
    resetPage = true,
  ) => {
    const query = new URLSearchParams(searchParams.toString());
    if (resetPage) query.set("page", "1");
    update(query);
    router.replace(`/recommendations?${query.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = useActiveProfile(profilesQuery.data);
  const profileId = profile?.id;
  const recommendationsKey = useMemo(() => [
    "recommendations",
    profileId,
    requestedRun || "new",
    filterKey,
  ] as const, [filterKey, profileId, requestedRun]);
  const recommendationsQuery = useQuery({
    queryKey: recommendationsKey,
    queryFn: async () => {
      if (requestedRun) {
        const run = await loadRecommendationRun(requestedRun);
        if (run.profile_id !== profileId) throw new Error("推荐记录不属于当前资料");
        if (runMatchesFilters(run.filters, filterRecord)) {
          return {
            items: run.items,
            runId: run.id,
            source: "api" as const,
            hasMore: run.has_more ?? run.items.length >= 100,
          };
        }
      }
      return loadRecommendations(profileId!, appliedFilters);
    },
    enabled: Boolean(profileId && profile.rating_count >= 5),
  });
  const { data, isError, isFetching, isPending } = recommendationsQuery;
  const recommendations = useMemo(() => data?.items ?? [], [data?.items]);
  const filtered = useMemo(() => {
    if (sort === "年份") {
      return [...recommendations].sort((left, right) => right.anime.year - left.anime.year);
    }
    if (sort === "支持人数") {
      return [...recommendations].sort((left, right) => right.support - left.support);
    }
    return recommendations;
  }, [recommendations, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const pageItems = filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);
  const activeFilterCount = Number(format !== "全部")
    + Number(minimum > 0)
    + Number(filterRelated)
    + Number(!includeShortForm)
    + Number(scoreFilterEnabled)
    + Number(yearFilterEnabled);
  const yearStart = ((minimumYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
  const yearEnd = ((maximumYear - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;

  useEffect(() => {
    rememberedFilterState = {
      format,
      minimumSupport: minimum,
      filterRelated,
      includeShortForm,
      scoreFilterEnabled,
      minimumScore,
      yearFilterEnabled,
      minimumYear,
      maximumYear,
    };
  }, [
    filterRelated,
    format,
    includeShortForm,
    maximumYear,
    minimum,
    minimumScore,
    minimumYear,
    scoreFilterEnabled,
    yearFilterEnabled,
  ]);

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

  const changePage = (
    page: number,
    maximumPages = totalPages,
    runId = data?.runId,
  ) => {
    const nextPage = Math.max(1, Math.min(page, maximumPages));
    setCurrentPage(nextPage);
    const query = new URLSearchParams(searchParams.toString());
    query.set("page", String(nextPage));
    if (runId) query.set("run", String(runId));
    router.replace(`/recommendations?${query.toString()}`, { scroll: false });
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const pageGroupStart = Math.floor((activePage - 1) / 5) * 5 + 1;
  const pageGroupEnd = Math.min(pageGroupStart + 4, totalPages);

  async function openNextPageGroup() {
    const targetPage = pageGroupEnd + 1;
    if (targetPage <= totalPages) {
      changePage(targetPage);
      return;
    }
    if (!data?.hasMore || !profileId || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const refreshed = await loadRecommendations(profileId, appliedFilters, {
        limit: data.items.length + 100,
        runId: data.runId,
      });
      queryClient.setQueryData(recommendationsKey, refreshed);
      const nextTotalPages = Math.max(1, Math.ceil(refreshed.items.length / PAGE_SIZE));
      changePage(targetPage, nextTotalPages, refreshed.runId);
    } finally {
      setIsLoadingMore(false);
    }
  }

  function resetFilters() {
    const defaults: RememberedFilterState = {
      format: "全部",
      minimumSupport: 0,
      filterRelated: false,
      includeShortForm: true,
      scoreFilterEnabled: false,
      minimumScore: DEFAULT_MINIMUM_SCORE,
      yearFilterEnabled: false,
      minimumYear: YEAR_MIN,
      maximumYear: YEAR_MAX,
    };
    rememberedFilterState = defaults;
    setFormat(defaults.format);
    setMinimum(defaults.minimumSupport);
    setFilterRelated(defaults.filterRelated);
    setIncludeShortForm(defaults.includeShortForm);
    setScoreFilterEnabled(defaults.scoreFilterEnabled);
    setMinimumScore(defaults.minimumScore);
    setYearFilterEnabled(defaults.yearFilterEnabled);
    setMinimumYear(defaults.minimumYear);
    setMaximumYear(defaults.maximumYear);
    setCurrentPage(1);
    setAppliedFilters({
      format: defaults.format,
      minimumSupport: defaults.minimumSupport,
      minimumBangumiScore: null,
      minimumYear: null,
      maximumYear: null,
      includeShortForm: defaults.includeShortForm,
      excludeRelated: defaults.filterRelated,
    });
    replaceQuery((query) => {
      FILTER_QUERY_KEYS.forEach((key) => query.delete(key));
      query.delete("run");
    });
  }

  const rememberPosition = () => {
    if (!data?.runId) return;
    sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify({
      runId: data.runId,
      page: activePage,
      scrollY: window.scrollY,
    }));
  };

  function applyMinimumScore(event: SyntheticEvent<HTMLInputElement>) {
    const value = Number(event.currentTarget.value);
    setAppliedFilters((current) => ({
      ...current,
      minimumBangumiScore: value,
    }));
  }

  function applyMinimumYear(event: SyntheticEvent<HTMLInputElement>) {
    const value = Math.min(Number(event.currentTarget.value), maximumYear);
    setAppliedFilters((current) => ({
      ...current,
      minimumYear: value,
      maximumYear,
    }));
  }

  function applyMaximumYear(event: SyntheticEvent<HTMLInputElement>) {
    const value = Math.max(Number(event.currentTarget.value), minimumYear);
    setAppliedFilters((current) => ({
      ...current,
      minimumYear,
      maximumYear: value,
    }));
  }

  function applyMinimumSupport(event: SyntheticEvent<HTMLInputElement>) {
    const value = Number(event.currentTarget.value);
    setAppliedFilters((current) => ({
      ...current,
      minimumSupport: value,
    }));
  }

  const handleFeedback = useCallback(
    async (action: "favorite" | "hide", malId: number) => {
      if (!data) return;
      await sendRecommendationFeedback(data.runId, malId, action);
      if (action === "hide") {
        try {
          const refreshed = await loadRecommendations(profileId!, appliedFilters, {
            limit: data.items.length,
            runId: data.runId,
          });
          queryClient.setQueryData(recommendationsKey, refreshed);
        } catch (error) {
          if (profileId) {
            await removeCollectionItem(profileId, "hidden", malId).catch(() => undefined);
          }
          throw error;
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["profile-collections", profileId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard-recommendations", profileId] });
      void queryClient.invalidateQueries({ queryKey: ["recommendation-history", profileId] });
    },
    [appliedFilters, data, profileId, queryClient, recommendationsKey],
  );

  const detailParams = new URLSearchParams(searchParams.toString());
  detailParams.delete("run");
  detailParams.delete("page");
  detailParams.set("fromPage", String(activePage));

  return (
    <div className="page recommendations-page">
      <div className="recommendation-toolbar">
        <div className="segmented" aria-label="视图切换">
          <button
            className={view === "grid" ? "active" : ""}
            onClick={() => {
              setView("grid");
              replaceQuery((query) => query.delete("view"), false);
            }}
            aria-pressed={view === "grid"}
          >
            <GridFour size={18} /> 网格
          </button>
          <button
            className={view === "list" ? "active" : ""}
            onClick={() => {
              setView("list");
              replaceQuery((query) => query.set("view", "list"), false);
            }}
            aria-pressed={view === "list"}
          >
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
            onValueChange={(value) => {
              setSort(value);
              setCurrentPage(1);
              replaceQuery((query) => {
                if (value === "推荐分数") query.delete("sort");
                else query.set("sort", value);
              });
            }}
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
                  <div className="drawer-heading-actions">
                    <button className="button quiet" type="button" onClick={resetFilters}>
                      <ArrowCounterClockwise size={17} /> 重置
                    </button>
                    <Dialog.Close className="button quiet">完成</Dialog.Close>
                  </div>
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
                        onClick={() => {
                          setFormat(option.value);
                          setCurrentPage(1);
                          setAppliedFilters((current) => ({
                            ...current,
                            format: option.value,
                          }));
                          replaceQuery((query) => {
                            if (option.value === "全部") query.delete("format");
                            else query.set("format", option.value);
                          });
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>Bangumi 评分</legend>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={scoreFilterEnabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setScoreFilterEnabled(enabled);
                        setCurrentPage(1);
                        setAppliedFilters((current) => ({
                          ...current,
                          minimumBangumiScore: enabled ? minimumScore : null,
                        }));
                        replaceQuery((query) => {
                          if (enabled) query.set("score", minimumScore.toFixed(1));
                          else query.delete("score");
                        });
                      }}
                    />
                    <span>按评分过滤</span>
                    <i aria-hidden="true" />
                  </label>
                  {scoreFilterEnabled && (
                    <div className="filter-slider-field">
                      <div className="filter-slider-heading">
                        <span>最低评分</span>
                        <output>{minimumScore.toFixed(1)}</output>
                      </div>
                      <input
                        className="filter-slider"
                        type="range"
                        min={SCORE_MIN}
                        max={SCORE_MAX}
                        step="0.1"
                        value={minimumScore}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setMinimumScore(value);
                          setCurrentPage(1);
                          replaceQuery((query) => query.set("score", value.toFixed(1)));
                        }}
                        onPointerUp={applyMinimumScore}
                        onKeyUp={applyMinimumScore}
                        onBlur={applyMinimumScore}
                      />
                    </div>
                  )}
                </fieldset>
                <fieldset>
                  <legend>发行年份</legend>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={yearFilterEnabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setYearFilterEnabled(enabled);
                        setCurrentPage(1);
                        setAppliedFilters((current) => ({
                          ...current,
                          minimumYear: enabled ? minimumYear : null,
                          maximumYear: enabled ? maximumYear : null,
                        }));
                        replaceQuery((query) => {
                          if (enabled) query.set("year", `${minimumYear}-${maximumYear}`);
                          else query.delete("year");
                        });
                      }}
                    />
                    <span>按年份过滤</span>
                    <i aria-hidden="true" />
                  </label>
                  {yearFilterEnabled && (
                    <div className="filter-slider-field">
                      <div className="filter-slider-heading">
                        <span>年份区间</span>
                        <output>{minimumYear} - {maximumYear}</output>
                      </div>
                      <div
                        className="dual-thumb-range"
                        style={{
                          "--range-start": `${yearStart}%`,
                          "--range-end": `${yearEnd}%`,
                        } as CSSProperties}
                      >
                        <div className="dual-thumb-track" />
                        <input
                          aria-label="最早发行年份"
                          type="range"
                          min={YEAR_MIN}
                          max={YEAR_MAX}
                          step="1"
                          value={minimumYear}
                          onChange={(event) => {
                            const value = Math.min(Number(event.target.value), maximumYear);
                            setMinimumYear(value);
                            setCurrentPage(1);
                            replaceQuery((query) => query.set("year", `${value}-${maximumYear}`));
                          }}
                          onPointerUp={applyMinimumYear}
                          onKeyUp={applyMinimumYear}
                          onBlur={applyMinimumYear}
                        />
                        <input
                          aria-label="最晚发行年份"
                          type="range"
                          min={YEAR_MIN}
                          max={YEAR_MAX}
                          step="1"
                          value={maximumYear}
                          onChange={(event) => {
                            const value = Math.max(Number(event.target.value), minimumYear);
                            setMaximumYear(value);
                            setCurrentPage(1);
                            replaceQuery((query) => query.set("year", `${minimumYear}-${value}`));
                          }}
                          onPointerUp={applyMaximumYear}
                          onKeyUp={applyMaximumYear}
                          onBlur={applyMaximumYear}
                        />
                      </div>
                    </div>
                  )}
                </fieldset>
                <fieldset>
                  <div className="filter-slider-heading">
                    <span className="filter-field-label">最低相似观众支持</span>
                    <output>{minimum ? `${minimum} 人` : "不限"}</output>
                  </div>
                  <input
                    className="filter-slider"
                    type="range"
                    min="0"
                    max="20"
                    step="5"
                    value={minimum}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setMinimum(value);
                      setCurrentPage(1);
                      replaceQuery((query) => {
                        if (value) query.set("support", String(value));
                        else query.delete("support");
                      });
                    }}
                    onPointerUp={applyMinimumSupport}
                    onKeyUp={applyMinimumSupport}
                    onBlur={applyMinimumSupport}
                  />
                </fieldset>
                <fieldset className="filter-toggle-group">
                  <legend>内容与系列</legend>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={includeShortForm}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setIncludeShortForm(checked);
                        setCurrentPage(1);
                        setAppliedFilters((current) => ({
                          ...current,
                          includeShortForm: checked,
                        }));
                        replaceQuery((query) => {
                          if (checked) query.delete("short");
                          else query.set("short", "0");
                        });
                      }}
                    />
                    <span>包含泡面番</span>
                    <i aria-hidden="true" />
                  </label>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={filterRelated}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setFilterRelated(checked);
                        setCurrentPage(1);
                        setAppliedFilters((current) => ({
                          ...current,
                          excludeRelated: checked,
                        }));
                        replaceQuery((query) => {
                          if (checked) query.set("related", "1");
                          else query.delete("related");
                        });
                      }}
                    />
                    <span>过滤续作、衍生作</span>
                    <i aria-hidden="true" />
                  </label>
                </fieldset>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {profilesQuery.isPending || (
        Boolean(profile?.rating_count) &&
        (isPending || (isFetching && recommendations.length === 0))
      ) ? (
        <StatePanel title="正在生成推荐" />
      ) : profile && profile.rating_count < 5 ? (
        <StatePanel
          title="至少录入 5 条有效评分"
          action={{ label: "导入或手动评分", href: "/onboarding" }}
        />
      ) : profilesQuery.isError || isError ? (
        <StatePanel title="推荐暂时不可用" />
      ) : filtered.length ? (
        <>
          <div className={view === "grid" ? "recommendation-grid" : "recommendation-list"}>
            {pageItems.map((item) => (
              <RecommendationCard
                key={`${data?.runId}-${item.anime.mal_id}`}
                item={item}
                compact={view === "list"}
                runId={data?.runId}
                detailHref={`/recommendations/${data?.runId}/${item.anime.mal_id}?${detailParams.toString()}`}
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
                {recommendationPageItems(activePage, totalPages, data?.hasMore).map((item) =>
                  item === "previous" ? (
                    <button
                      type="button"
                      key="previous-group"
                      aria-label="前五页"
                      onClick={() => changePage(Math.max(1, pageGroupStart - 5))}
                    >
                      ···
                    </button>
                  ) : item === "next" ? (
                    <button
                      type="button"
                      key="next-group"
                      aria-label="加载后五页"
                      disabled={isLoadingMore}
                      onClick={() => void openNextPageGroup()}
                    >
                      ···
                    </button>
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
              <button
                type="button"
                aria-label="下一页"
                disabled={(activePage === totalPages && !data?.hasMore) || isLoadingMore}
                onClick={() => activePage < totalPages
                  ? changePage(activePage + 1)
                  : void openNextPageGroup()}
              >
                <CaretRight size={19} />
              </button>
            </nav>
          )}
        </>
      ) : (
        <StatePanel title="当前筛选没有结果" />
      )}
    </div>
  );
}
