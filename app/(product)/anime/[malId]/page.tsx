"use client";

import { CheckCircle, Info, Star } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AnimeCover } from "../../../components/anime-cover";
import { RatingControl } from "../../../components/rating-control";
import { ThemeSelect } from "../../../components/theme-select";
import { StatePanel } from "../../../components/ui";
import { useBangumiAnime } from "../../../lib/bangumi-client";
import {
  loadAnime,
  loadLibrary,
  loadProfiles,
  saveRatings,
  type WatchStatus,
} from "../../../lib/api";
import { useActiveProfile } from "../../../providers";

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

export default function AnimeDetailPage() {
  const params = useParams<{ malId: string }>();
  const malId = Number(params.malId);
  const [editedRating, setEditedRating] = useState<number | null | undefined>();
  const [editedStatus, setEditedStatus] = useState<WatchStatus | undefined>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const animeQuery = useQuery({
    queryKey: ["anime", malId],
    queryFn: () => loadAnime(malId),
    enabled: Number.isFinite(malId),
  });
  const item = useBangumiAnime(animeQuery.data);
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = useActiveProfile(profilesQuery.data);
  const libraryQuery = useQuery({
    queryKey: ["library", profile?.id],
    queryFn: () => loadLibrary(profile!.id),
    enabled: Boolean(profile),
  });
  const current = libraryQuery.data?.find((item) => item.mal_id === malId);
  const rating = editedRating !== undefined ? editedRating : current?.rating ?? null;
  const status = editedStatus ?? current?.status ?? "plan_to_watch";

  async function save() {
    if (!profile) return;
    setError("");
    try {
      await saveRatings(profile.id, [{ mal_id: malId, rating, status }]);
      await libraryQuery.refetch();
      setEditedRating(undefined);
      setEditedStatus(undefined);
      setNotice("观看记录已保存，推荐资料已标记为需要更新。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
  }

  if (animeQuery.isPending) {
    return <div className="page"><StatePanel title="正在读取作品" /></div>;
  }
  if (animeQuery.isError || !item) {
    return <div className="page"><StatePanel title="未找到这部番剧" /></div>;
  }
  return (
    <div className="page anime-page">
      <section className="anime-hero">
        <AnimeCover
          index={item.cover_index}
          title={item.title_zh || item.title_native}
          src={item.cover_url}
          priority
        />
        <div>
          <p className="eyebrow">{item.year ?? "年份未知"} · {item.format} · {item.episodes ?? "?"} 集 · {item.release_status}</p>
          <h1>{item.title_zh || item.title_native}</h1>
          <p className="native-title">{item.title_native}<br />{item.title_en}</p>
          <p className="synopsis">{item.synopsis || "目录暂未提供简介。"}</p>
        </div>
        <div className="rating-editor">
          <p className="eyebrow">我的记录</p>
          <div className="rating-field">
            <span>观看状态</span>
            <ThemeSelect
              value={status}
              ariaLabel="观看状态"
              options={statusOptions}
              onValueChange={(value) => {
                const nextStatus = value as WatchStatus;
                setEditedStatus(nextStatus);
                if (nextStatus === "plan_to_watch") {
                  setEditedRating(null);
                }
              }}
            />
          </div>
          <label>
            我的评分
            <RatingControl
              value={rating}
              label="我的评分"
              disabled={status === "plan_to_watch"}
              onChange={setEditedRating}
            />
          </label>
          <button className="button primary" disabled={!profile} onClick={() => void save()}>
            <CheckCircle size={18} /> 保存记录
          </button>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      </section>
      <div className="anime-facts">
        <section>
          <span><Star size={18} /> Bangumi 评分</span>
          <strong>{item.bangumi_score?.toFixed(1) ?? "暂无"}</strong>
        </section>
        <section>
          <span><Info size={18} /> 当前推荐证据</span>
          <strong className="small-value">从推荐页查看</strong>
        </section>
      </div>
      <section className="section-block relation-tree">
        <p className="eyebrow">系列关系</p>
        <h2>观看顺序</h2>
      </section>
    </div>
  );
}
