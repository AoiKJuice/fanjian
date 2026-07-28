"use client";

import {
  BookmarkSimple,
  EyeSlash,
  GridFour,
  LinkSimple,
  List,
  MagnifyingGlass,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimeCover } from "../../components/anime-cover";
import { CatalogAddDialog } from "../../components/catalog-add";
import { RatingControl } from "../../components/rating-control";
import { ThemeSelect } from "../../components/theme-select";
import { PageHeader, StatePanel } from "../../components/ui";
import {
  associateExternalRating,
  loadCollections,
  loadLibrary,
  loadProfiles,
  loadRecommendations,
  loadUnmappedLibrary,
  removeCollectionItem,
  saveRatings,
  searchAnime,
  type CollectionItem,
  type ExternalLibraryItem,
  type LibraryItem,
  type ProfileCollections,
  type WatchStatus,
} from "../../lib/api";
import type { Anime } from "../../lib/data";

const statusLabels: Record<WatchStatus, string> = {
  completed: "已看完",
  watching: "观看中",
  dropped: "已弃",
  on_hold: "搁置",
  plan_to_watch: "计划观看",
};
const statusOptions = Object.entries(statusLabels).map(([value, label]) => ({
  value,
  label,
}));

function CollectionManager({
  kind,
  items,
  query,
  pendingId,
  onQueryChange,
  onRemove,
}: {
  kind: "favorites" | "hidden";
  items: CollectionItem[];
  query: string;
  pendingId: number | null;
  onQueryChange: (value: string) => void;
  onRemove: (malId: number) => void;
}) {
  const filtered = items.filter((item) => {
    const title =
      item.anime?.title_zh ||
      item.anime?.title_native ||
      `MAL #${item.mal_id}`;
    return title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const isFavorite = kind === "favorites";

  return (
    <section className="collection-manager">
      <div className="library-toolbar">
        <label className="inline-search">
          <MagnifyingGlass size={18} aria-hidden />
          <span className="sr-only">
            {isFavorite ? "搜索想看作品" : "搜索不感兴趣作品"}
          </span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={isFavorite ? "搜索想看作品" : "搜索不感兴趣作品"}
          />
        </label>
      </div>

      {!items.length ? (
        <StatePanel
          title={isFavorite ? "还没有想看的作品" : "还没有忽略的作品"}
          action={{ label: "浏览推荐", href: "/recommendations" }}
        />
      ) : !filtered.length ? (
        <StatePanel title="没有匹配的作品" />
      ) : (
        <div className="collection-grid">
          {filtered.map((item) => {
            const title =
              item.anime?.title_zh ||
              item.anime?.title_native ||
              `MAL #${item.mal_id}`;
            return (
              <article key={item.mal_id}>
                <Link
                  className="collection-cover-link"
                  href={`/anime/${item.mal_id}`}
                >
                  <AnimeCover
                    index={item.anime?.cover_index ?? 0}
                    title={title}
                    src={item.anime?.cover_url}
                  />
                </Link>
                <div className="collection-copy">
                  <Link href={`/anime/${item.mal_id}`}>
                    <h2>{title}</h2>
                  </Link>
                  <p>
                    {item.anime
                      ? `${item.anime.year || "年份未知"} · ${item.anime.format}`
                      : `MAL #${item.mal_id}`}
                  </p>
                  <button
                    className="button secondary"
                    disabled={pendingId === item.mal_id}
                    onClick={() => onRemove(item.mal_id)}
                  >
                    <X size={17} aria-hidden />
                    {pendingId === item.mal_id
                      ? "处理中…"
                      : isFavorite
                        ? "移出想看"
                        : "取消忽略"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function LibraryPage() {
  const params = useSearchParams();
  const [section, setSection] = useState<
    "ratings" | "favorites" | "hidden"
  >("ratings");
  const [view, setView] = useState<"table" | "covers">("table");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState<"all" | WatchStatus>("all");
  const [profileId, setProfileId] = useState<number | null>(null);
  const [rows, setRows] = useState<LibraryItem[]>([]);
  const [unmappedRows, setUnmappedRows] = useState<ExternalLibraryItem[]>([]);
  const [collections, setCollections] = useState<ProfileCollections>({
    favorites: [],
    hidden: [],
  });
  const [pendingCollectionId, setPendingCollectionId] = useState<
    number | null
  >(null);
  const [mappingItem, setMappingItem] = useState<
    ExternalLibraryItem | null
  >(null);
  const [mappingQuery, setMappingQuery] = useState("");
  const [mappingResults, setMappingResults] = useState<Anime[]>([]);
  const [mappingSearching, setMappingSearching] = useState(false);
  const [mappingSavingId, setMappingSavingId] = useState<number | null>(
    null,
  );
  const [mappingNotice, setMappingNotice] = useState("");
  const [changedIds, setChangedIds] = useState<Set<number>>(new Set());
  const [changedExternalIds, setChangedExternalIds] =
    useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadProfiles()
      .then(async (profiles) => {
        if (!profiles.length) return;
        setProfileId(profiles[0].id);
        const [library, unmapped, savedCollections] = await Promise.all([
          loadLibrary(profiles[0].id),
          loadUnmappedLibrary(profiles[0].id),
          loadCollections(profiles[0].id),
        ]);
        setRows(library);
        setUnmappedRows(unmapped);
        setCollections(savedCollections);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!profileId) return;
    const refreshLibrary = () => {
      void loadLibrary(profileId)
        .then((library) => {
          setRows((current) => {
            const currentById = new Map(
              current.map((item) => [item.mal_id, item]),
            );
            return library.map((item) =>
              changedIds.has(item.mal_id)
                ? currentById.get(item.mal_id) ?? item
                : item,
            );
          });
        })
        .catch((reason: Error) => setError(reason.message));
    };
    window.addEventListener("anime-library-changed", refreshLibrary);
    return () =>
      window.removeEventListener(
        "anime-library-changed",
        refreshLibrary,
      );
  }, [changedIds, profileId]);

  async function removeSavedItem(malId: number) {
    if (!profileId || section === "ratings") return;
    setPendingCollectionId(malId);
    setError("");
    try {
      await removeCollectionItem(profileId, section, malId);
      setCollections((current) => ({
        ...current,
        [section]: current[section].filter(
          (item) => item.mal_id !== malId,
        ),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setPendingCollectionId(null);
    }
  }

  async function findMappingCandidates(query: string) {
    const normalized = query.trim();
    if (!normalized) return;
    setMappingSearching(true);
    setError("");
    try {
      const result = await searchAnime(normalized, 8);
      setMappingResults(result.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "搜索失败");
    } finally {
      setMappingSearching(false);
    }
  }

  function openMapping(item: ExternalLibraryItem) {
    setMappingItem(item);
    setMappingQuery(item.title);
    setMappingResults([]);
    setMappingNotice("");
    void findMappingCandidates(item.title);
  }

  async function confirmMapping(candidate: Anime) {
    if (!profileId || !mappingItem || mappingSavingId !== null) return;
    setMappingSavingId(candidate.mal_id);
    setError("");
    try {
      await associateExternalRating(
        profileId,
        mappingItem,
        candidate.mal_id,
      );
      const [library, unmapped] = await Promise.all([
        loadLibrary(profileId),
        loadUnmappedLibrary(profileId),
      ]);
      setRows(library);
      setUnmappedRows(unmapped);
      if (mappingItem.rating != null) {
        await loadRecommendations(profileId);
      }
      setMappingNotice(
        `已关联《${mappingItem.title}》与《${candidate.title_zh}》`,
      );
      setMappingItem(null);
      setMappingResults([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "关联失败");
    } finally {
      setMappingSavingId(null);
    }
  }

  function updateRow(
    malId: number,
    change: Partial<Pick<LibraryItem, "rating" | "status">>,
  ) {
    const normalizedChange =
      change.status === "plan_to_watch"
        ? { ...change, rating: null }
        : change;
    setRows((current) =>
      current.map((item) =>
        item.mal_id === malId ? { ...item, ...normalizedChange } : item,
      ),
    );
    setChangedIds((current) => new Set(current).add(malId));
  }

  function updateUnmappedRow(
    externalId: string,
    change: Partial<Pick<ExternalLibraryItem, "rating" | "status">>,
  ) {
    const normalizedChange =
      change.status === "plan_to_watch"
        ? { ...change, rating: null }
        : change;
    setUnmappedRows((current) =>
      current.map((item) =>
        item.external_id === externalId
          ? { ...item, ...normalizedChange }
          : item,
      ),
    );
    setChangedExternalIds((current) =>
      new Set(current).add(externalId)
    );
  }

  async function saveAndGenerate() {
    if (
      !profileId ||
      (!changedIds.size && !changedExternalIds.size)
    ) return;
    setSaving(true);
    setError("");
    try {
      const changed = rows
        .filter((item) => changedIds.has(item.mal_id))
        .map(({ mal_id, rating, status: watchStatus }) => ({
          mal_id,
          rating,
          status: watchStatus,
        }));
      const changedExternal = unmappedRows.filter((item) =>
        changedExternalIds.has(item.external_id)
      );
      await saveRatings(profileId, changed, changedExternal);
      if (changed.length) {
        await loadRecommendations(profileId);
      }
      setChangedIds(new Set());
      setChangedExternalIds(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        const title =
          row.anime?.title_zh || row.anime?.title_native || String(row.mal_id);
        return (
          title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
          (status === "all" || row.status === status)
        );
      }),
    [rows, query, status],
  );

  const columns = useMemo<ColumnDef<LibraryItem>[]>(
    () => [
      {
        id: "anime",
        header: "作品",
        cell: ({ row }) => {
          const item = row.original.anime;
          const title = item?.title_zh || item?.title_native || `MAL #${row.original.mal_id}`;
          return (
            <div className="table-title">
              <AnimeCover
                index={item?.cover_index ?? 0}
                title={title}
                src={item?.cover_url}
              />
              <div>
                <strong>{title}</strong>
                <span>{item ? `${item.year ?? "年份未知"} · ${item.format}` : "目录中未找到"}</span>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => (
          <ThemeSelect
            compact
            value={row.original.status}
            ariaLabel={`${row.original.anime?.title_zh ?? row.original.mal_id}观看状态`}
            options={statusOptions}
            onValueChange={(value) =>
              updateRow(row.original.mal_id, {
                status: value as WatchStatus,
              })
            }
          />
        ),
      },
      {
        accessorKey: "rating",
        header: "评分",
        cell: ({ row }) => (
          <RatingControl
            compact
            value={row.original.rating}
            disabled={row.original.status === "plan_to_watch"}
            label={`${row.original.anime?.title_zh ?? row.original.mal_id}评分`}
            onChange={(rating) =>
              updateRow(row.original.mal_id, { rating })
            }
          />
        ),
      },
      {
        accessorKey: "updated_at",
        header: "最近修改",
        cell: ({ row }) => new Date(row.original.updated_at).toLocaleDateString("zh-CN"),
      },
    ],
    [],
  );
  // TanStack Table exposes callable row helpers that React Compiler intentionally skips.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const tableViewport = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableViewport.current,
    estimateSize: () => 72,
    overscan: 8,
  });

  return (
    <div className="page">
      <PageHeader
        title="我的片库"
        actions={
          <div className="library-header-actions">
            <CatalogAddDialog profileId={profileId} />
            <Link className="button secondary" href="/onboarding">
              <UploadSimple size={18} /> 导入并预览
            </Link>
          </div>
        }
      />

      <div className="library-sections segmented" role="tablist" aria-label="片库分类">
        <button
          role="tab"
          aria-selected={section === "ratings"}
          className={section === "ratings" ? "active" : ""}
          onClick={() => setSection("ratings")}
        >
          <List size={17} aria-hidden />
          观看记录
        </button>
        <button
          role="tab"
          aria-selected={section === "favorites"}
          className={section === "favorites" ? "active" : ""}
          onClick={() => setSection("favorites")}
        >
          <BookmarkSimple size={17} aria-hidden />
          想看 <span>{collections.favorites.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={section === "hidden"}
          className={section === "hidden" ? "active" : ""}
          onClick={() => setSection("hidden")}
        >
          <EyeSlash size={17} aria-hidden />
          不感兴趣 <span>{collections.hidden.length}</span>
        </button>
      </div>

      {section === "ratings" ? (
        <>
      {!!(changedIds.size + changedExternalIds.size) && (
        <div className="change-banner" role="status">
          <span>推荐资料已变化</span>
          <p>
            {changedIds.size + changedExternalIds.size} 条记录等待保存。
            {changedIds.size
              ? "已关联作品保存后会生成一组新推荐。"
              : "待关联作品只保存评分，不参与当前推荐。"}
          </p>
          <button
            className="button primary"
            disabled={saving}
            onClick={() => void saveAndGenerate()}
          >
            {saving ? "保存并计算中…" : "保存并生成"}
          </button>
        </div>
      )}
      {error && <p className="inline-note" role="alert">{error}</p>}
      {mappingNotice && (
        <div className="success-notice" role="status">
          {mappingNotice}
        </div>
      )}

      {!!unmappedRows.length && (
        <section className="unmapped-library" aria-labelledby="unmapped-title">
          <header>
            <h2 id="unmapped-title">待关联项目 · {unmappedRows.length}</h2>
          </header>
          <div className="unmapped-grid">
            {unmappedRows.map((item) => (
              <article key={`${item.source}:${item.external_id}`}>
                <AnimeCover
                  index={0}
                  title={item.title}
                  src={item.cover_url}
                />
                <div>
                  <strong>{item.title}</strong>
                  <span>Bangumi #{item.external_id}</span>
                </div>
                <ThemeSelect
                  compact
                  value={item.status}
                  ariaLabel={`${item.title}观看状态`}
                  options={statusOptions}
                  onValueChange={(value) =>
                    updateUnmappedRow(item.external_id, {
                      status: value as WatchStatus,
                    })
                  }
                />
                <RatingControl
                  compact
                  value={item.rating}
                  disabled={item.status === "plan_to_watch"}
                  label={`${item.title}评分`}
                  onChange={(rating) =>
                    updateUnmappedRow(item.external_id, { rating })
                  }
                />
                <button
                  className="button secondary unmapped-link-button"
                  onClick={() => openMapping(item)}
                >
                  <LinkSimple size={17} aria-hidden />
                  关联作品
                </button>
              </article>
            ))}
          </div>
          {mappingItem && (
            <div className="mapping-panel">
              <div className="mapping-panel-heading">
                <h3>关联《{mappingItem.title}》</h3>
                <button
                  className="icon-button"
                  aria-label="关闭关联"
                  onClick={() => {
                    setMappingItem(null);
                    setMappingResults([]);
                  }}
                >
                  <X size={18} aria-hidden />
                </button>
              </div>
              <form
                className="mapping-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void findMappingCandidates(mappingQuery);
                }}
              >
                <label className="inline-search">
                  <MagnifyingGlass size={18} aria-hidden />
                  <span className="sr-only">搜索完整番剧目录</span>
                  <input
                    value={mappingQuery}
                    onChange={(event) =>
                      setMappingQuery(event.target.value)
                    }
                    placeholder="输入中文、原名或 MAL ID"
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={mappingSearching}
                  type="submit"
                >
                  {mappingSearching ? "搜索中…" : "搜索"}
                </button>
              </form>
              {mappingResults.length ? (
                <div className="mapping-results">
                  {mappingResults.map((candidate) => (
                    <article key={candidate.mal_id}>
                      <AnimeCover
                        index={candidate.cover_index}
                        title={candidate.title_zh}
                        src={candidate.cover_url}
                      />
                      <div>
                        <strong>{candidate.title_zh}</strong>
                        <span>
                          {candidate.year || "年份未知"} · {candidate.format}
                        </span>
                      </div>
                      <button
                        className="button secondary"
                        disabled={mappingSavingId !== null}
                        onClick={() => void confirmMapping(candidate)}
                      >
                        {mappingSavingId === candidate.mal_id
                          ? "关联中…"
                          : "确认关联"}
                      </button>
                    </article>
                  ))}
                </div>
              ) : !mappingSearching ? (
                <StatePanel
                  title="没有匹配候选"
                />
              ) : null}
            </div>
          )}
        </section>
      )}

      <div className="library-toolbar">
        <label className="inline-search">
          <MagnifyingGlass size={18} aria-hidden />
          <span className="sr-only">搜索片库</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索当前片库"
          />
        </label>
        <ThemeSelect
          value={status}
          ariaLabel="观看状态"
          options={[{ value: "all", label: "全部状态" }, ...statusOptions]}
          onValueChange={(value) =>
            setStatus(value as "all" | WatchStatus)
          }
        />
        <div className="segmented">
          <button
            className={view === "table" ? "active" : ""}
            onClick={() => setView("table")}
            aria-label="表格视图"
          >
            <List size={18} />
          </button>
          <button
            className={view === "covers" ? "active" : ""}
            onClick={() => setView("covers")}
            aria-label="封面视图"
          >
            <GridFour size={18} />
          </button>
        </div>
      </div>

      {loading ? (
        <StatePanel title="正在读取片库" />
      ) : !rows.length ? (
        <StatePanel
          title="片库还是空的"
          action={{ label: "导入评分", href: "/onboarding" }}
        />
      ) : !filtered.length ? (
        <StatePanel title="没有匹配的片库项目" />
      ) : view === "table" ? (
        <div
          className="data-table-wrap virtual-table-wrap"
          ref={tableViewport}
        >
          <div className="library-virtual-table" role="table">
            <div className="library-table-head" role="rowgroup">
              {table.getHeaderGroups().map((group) => (
                <div className="library-table-row" role="row" key={group.id}>
                  {group.headers.map((header) => (
                    <div role="columnheader" key={header.id}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div
              className="library-table-body"
              role="rowgroup"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = tableRows[virtualRow.index];
                return (
                  <div
                    className="library-table-row"
                    role="row"
                    key={row.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div role="cell" key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="library-cover-grid">
          {filtered.map((row) => {
            const title =
              row.anime?.title_zh || row.anime?.title_native || `MAL #${row.mal_id}`;
            return (
              <article key={row.mal_id}>
                <AnimeCover
                  index={row.anime?.cover_index ?? 0}
                  title={title}
                  src={row.anime?.cover_url}
                />
                <h2>{title}</h2>
                <p>{statusLabels[row.status]} · {row.rating ?? "未评分"}</p>
                <RatingControl
                  value={row.rating}
                  disabled={row.status === "plan_to_watch"}
                  label={`${title}评分`}
                  onChange={(rating) => updateRow(row.mal_id, { rating })}
                />
              </article>
            );
          })}
        </div>
      )}
        </>
      ) : (
        <>
          {error && <p className="inline-note" role="alert">{error}</p>}
          {loading ? (
            <StatePanel
              title="正在读取本地列表"
            />
          ) : (
            <CollectionManager
              kind={section}
              items={collections[section]}
              query={query}
              pendingId={pendingCollectionId}
              onQueryChange={setQuery}
              onRemove={(malId) => void removeSavedItem(malId)}
            />
          )}
        </>
      )}
    </div>
  );
}
