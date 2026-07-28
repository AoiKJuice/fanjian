"use client";

import {
  ArrowLeft,
  Check,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Dialog, Popover } from "radix-ui";
import { FormEvent, useEffect, useState } from "react";
import {
  loadLibrary,
  loadRecommendations,
  saveRatings,
  searchAnime,
  type WatchStatus,
} from "../lib/api";
import type { Anime } from "../lib/data";
import { AnimeCover } from "./anime-cover";
import { RatingControl } from "./rating-control";
import { ThemeSelect } from "./theme-select";

const statusOptions = [
  { value: "completed", label: "已看完" },
  { value: "watching", label: "观看中" },
  { value: "on_hold", label: "搁置" },
  { value: "dropped", label: "已弃" },
  { value: "plan_to_watch", label: "计划观看" },
];

function animeTitle(anime: Anime) {
  return anime.title_zh || anime.title_native || anime.title_en;
}

function CatalogAddContent({
  profileId,
  initialFocus = false,
  searchValue,
  showSearchField = true,
  onClose,
}: {
  profileId?: number;
  initialFocus?: boolean;
  searchValue?: string;
  showSearchField?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState<Anime | null>(null);
  const [status, setStatus] = useState<WatchStatus>("completed");
  const [rating, setRating] = useState<number | null>(null);
  const [wasExisting, setWasExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTitle, setSavedTitle] = useState("");
  const [error, setError] = useState("");
  const effectiveQuery = searchValue ?? query;

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(effectiveQuery.trim()),
      220,
    );
    return () => clearTimeout(timer);
  }, [effectiveQuery]);

  const resultsQuery = useQuery({
    queryKey: ["catalog-search", debouncedQuery],
    queryFn: () => searchAnime(debouncedQuery, 12),
    enabled: Boolean(debouncedQuery),
    staleTime: 5 * 60_000,
  });

  const libraryQuery = useQuery({
    queryKey: ["library-items", profileId],
    queryFn: () => loadLibrary(profileId!),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  });

  function chooseAnime(anime: Anime) {
    const existing = libraryQuery.data?.find(
      (item) => item.mal_id === anime.mal_id,
    );
    setSelected(anime);
    setStatus(existing?.status ?? "completed");
    setRating(existing?.rating ?? null);
    setWasExisting(Boolean(existing));
    setSavedTitle("");
    setError("");
  }

  async function addToLibrary() {
    if (!selected || !profileId || saving) {
      if (!profileId) setError("请先建立本地资料");
      return;
    }
    setSaving(true);
    setError("");
    const normalizedRating = status === "plan_to_watch" ? null : rating;
    try {
      await saveRatings(profileId, [
        {
          mal_id: selected.mal_id,
          status,
          rating: normalizedRating,
        },
      ]);
      if (normalizedRating != null) {
        const recommendations = await loadRecommendations(profileId);
        queryClient.setQueryData(
          ["recommendations", profileId],
          recommendations,
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard-recommendations", profileId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["recommendation-history", profileId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["library-items", profileId],
        }),
      ]);
      window.dispatchEvent(
        new CustomEvent("anime-library-changed", {
          detail: { profileId, malId: selected.mal_id },
        }),
      );
      setSavedTitle(animeTitle(selected));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (savedTitle) {
    return (
      <div className="catalog-saved" role="status">
        <Check size={30} weight="bold" aria-hidden />
        <h2>{wasExisting ? "片库已更新" : "已加入片库"}</h2>
        <strong>{savedTitle}</strong>
        <div>
          {showSearchField ? (
            <button
              className="button secondary"
              onClick={() => {
                setSelected(null);
                setSavedTitle("");
                setQuery("");
              }}
            >
              继续添加
            </button>
          ) : (
            <button className="button secondary" onClick={onClose}>
              完成
            </button>
          )}
          <Link className="button primary" href="/library" onClick={onClose}>
            查看片库
          </Link>
        </div>
      </div>
    );
  }

  if (selected) {
    const title = animeTitle(selected);
    return (
      <div className="catalog-editor">
        <div className="catalog-editor-heading">
          <button
            className="icon-button"
            aria-label="返回搜索结果"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={19} aria-hidden />
          </button>
          <AnimeCover
            index={selected.cover_index}
            title={title}
            src={selected.cover_url}
          />
          <div>
            <h2>{title}</h2>
            <strong>
              {selected.year || "年份未知"} · {selected.format}
            </strong>
          </div>
        </div>
        <div className="catalog-editor-controls">
          <label>
            <span>观看状态</span>
            <ThemeSelect
              value={status}
              ariaLabel={`${title}观看状态`}
              options={statusOptions}
              onValueChange={(value) => {
                const nextStatus = value as WatchStatus;
                setStatus(nextStatus);
                if (nextStatus === "plan_to_watch") setRating(null);
              }}
            />
          </label>
          <label>
            <span>评分（可不填）</span>
            <RatingControl
              value={rating}
              disabled={status === "plan_to_watch"}
              label={`${title}评分`}
              onChange={setRating}
            />
          </label>
        </div>
        {error && (
          <p className="catalog-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary catalog-save"
          disabled={saving}
          onClick={() => void addToLibrary()}
        >
          {saving ? "保存中…" : wasExisting ? "更新片库" : "添加到片库"}
        </button>
      </div>
    );
  }

  const results = resultsQuery.data?.items ?? [];
  return (
    <div className="catalog-search-content">
      {showSearchField && (
        <form
          className="catalog-search-field"
          role="search"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setDebouncedQuery(query.trim());
          }}
        >
          <MagnifyingGlass size={19} aria-hidden />
          <input
            autoFocus={initialFocus}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入中文、原名或 MAL ID"
            aria-label="搜索完整番剧片库"
          />
          {query && (
            <button
              type="button"
              className="catalog-clear"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <X size={17} aria-hidden />
            </button>
          )}
        </form>
      )}

      {!debouncedQuery ? null : resultsQuery.isLoading ? (
        <div className="catalog-search-state" role="status">
          正在搜索
        </div>
      ) : resultsQuery.error ? (
        <div className="catalog-search-state error" role="alert">
          搜索失败
        </div>
      ) : !results.length ? (
        <div className="catalog-search-state">没有匹配作品</div>
      ) : (
        <div className="catalog-results" role="list" aria-label="番剧搜索结果">
          {results.map((anime) => {
            const title = animeTitle(anime);
            return (
              <div role="listitem" key={anime.mal_id}>
                <button
                  type="button"
                  className="catalog-result"
                  onClick={() => chooseAnime(anime)}
                >
                  <AnimeCover
                    index={anime.cover_index}
                    title={title}
                    src={anime.cover_url}
                  />
                  <span>
                    <strong>{title}</strong>
                    <b>
                      {anime.year || "年份未知"} · {anime.format} · MAL #
                      {anime.mal_id}
                    </b>
                  </span>
                  <Plus size={19} weight="bold" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GlobalCatalogSearch({
  profileId,
}: {
  profileId?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <form
          className="global-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) setOpen(true);
          }}
        >
          <MagnifyingGlass size={19} aria-hidden />
          <input
            value={query}
            onFocus={() => {
              if (query.trim()) setOpen(true);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(Boolean(event.target.value.trim()));
            }}
            placeholder="搜索完整片库并添加"
            aria-label="全局番剧搜索"
          />
          {query && (
            <button
              type="button"
              className="catalog-clear"
              aria-label="清空搜索"
              onClick={() => {
                setQuery("");
                setOpen(false);
              }}
            >
              <X size={17} aria-hidden />
            </button>
          )}
        </form>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="catalog-popover"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          onOpenAutoFocus={(event) => event.preventDefault()}
          aria-label="完整番剧片库搜索"
        >
          <CatalogAddContent
            profileId={profileId}
            searchValue={query}
            showSearchField={false}
            onClose={() => {
              setOpen(false);
              setQuery("");
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function CatalogAddDialog({
  profileId,
}: {
  profileId: number | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="button primary">
          <Plus size={18} weight="bold" aria-hidden />
          添加作品
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="catalog-dialog"
          aria-describedby={undefined}
        >
          <Dialog.Title>添加观看记录</Dialog.Title>
          <Dialog.Close className="icon-button catalog-dialog-close">
            <X size={19} aria-hidden />
            <span className="sr-only">关闭</span>
          </Dialog.Close>
          <CatalogAddContent
            profileId={profileId ?? undefined}
            initialFocus
            onClose={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
