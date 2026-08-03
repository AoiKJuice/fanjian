"use client";

import {
  Check,
  Database,
  DownloadSimple,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { PageHeader, StatePanel } from "../../components/ui";
import { browserModelEnabled } from "../../lib/browser-mode";
import {
  browserModelServerSnapshot,
  browserModelStatus,
  browserModelStatusSnapshot,
  downloadBrowserModel,
  subscribeBrowserModelStatus,
} from "../../lib/model-client";
import type { ModelStatus } from "../../lib/model-types";
import { serializeProfileBackup } from "../../lib/profile-backup";
import {
  selectActiveProfile,
  useActiveProfile,
  useTheme,
} from "../../providers";
import {
  deleteProfile,
  loadModelCard,
  loadProfileExportData,
  loadProfiles,
  type ModelCard,
  type Profile,
} from "../../lib/api";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [model, setModel] = useState<ModelCard | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const activeProfile = useActiveProfile(profiles);

  useEffect(() => {
    Promise.allSettled([loadProfiles(), loadModelCard()])
      .then(([profilesResult, modelResult]) => {
        if (profilesResult.status === "fulfilled") {
          setProfiles(profilesResult.value);
        } else {
          setError(
            profilesResult.reason instanceof Error
              ? profilesResult.reason.message
              : "资料读取失败",
          );
        }
        if (modelResult.status === "fulfilled") {
          setModel(modelResult.value);
        }
      })
      .finally(() => setLoadingProfiles(false));
  }, []);

  async function exportProfile(profile: Profile) {
    try {
      const data = await loadProfileExportData(profile.id);
      const payload = serializeProfileBackup(profile, data.ratings, data.collections);
      const url = URL.createObjectURL(
        new Blob([payload], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `fanjian-profile-${profile.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("本地资料已导出。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    }
  }

  async function removeProfile(profile: Profile) {
    try {
      await deleteProfile(profile.id);
      const remaining = profiles.filter((item) => item.id !== profile.id);
      setProfiles(remaining);
      queryClient.setQueryData(["profiles"], remaining);
      if (activeProfile?.id === profile.id) {
        selectActiveProfile(remaining[0]?.id ?? null);
      }
      setNotice(`“${profile.name}”及其本地记录已删除。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader
        title="设置"
      />
      {notice && <div className="success-notice" role="status">{notice}</div>}
      {error && <p className="inline-note" role="alert">{error}</p>}
      <section className="settings-section">
        <div className="settings-intro">
          <UserCircle size={24} weight="duotone" />
          <h2>本地资料</h2>
        </div>
        {loadingProfiles ? (
          <StatePanel title="正在读取资料" />
        ) : !profiles.length ? (
          <StatePanel
            title="还没有本地资料"
            action={{ label: "建立资料", href: "/onboarding" }}
          />
        ) : profiles.map((profile) => {
          const active = profile.id === activeProfile?.id;
          return (
          <div className={`profile-row${active ? " active" : ""}`} key={profile.id}>
            <span className="profile-avatar">{profile.name.slice(0, 1)}</span>
            <div>
              <strong>{profile.name}</strong>
              <span className="profile-stat">{profile.rating_count} 条评分</span>
            </div>
            <button
              className={`button profile-use-button${active ? " active" : " secondary"}`}
              aria-pressed={active}
              disabled={active}
              onClick={() => {
                selectActiveProfile(profile.id);
                setNotice(`当前使用“${profile.name}”。`);
              }}
            >
              {active && <Check size={16} weight="bold" aria-hidden />}
              {active ? "当前使用" : "使用此资料"}
            </button>
            <button
              className="button quiet"
              onClick={() => void exportProfile(profile)}
            >
              导出
            </button>
          </div>
          );
        })}
        <Link className="add-row" href="/onboarding?new=1">
          <Plus size={18} /> 新建或导入本地资料
        </Link>
      </section>
      <section className="settings-section">
        <div className="settings-intro">
          <Sun size={24} weight="duotone" />
          <h2>显示</h2>
        </div>
        <div className="setting-row">
          <strong>主题</strong>
          <div className="segmented">
            <button
              className={theme === "light" ? "active" : ""}
              aria-pressed={theme === "light"}
              onClick={() => setTheme("light")}
            >
              <Sun size={17} /> 浅色
            </button>
            <button
              className={theme === "dark" ? "active" : ""}
              aria-pressed={theme === "dark"}
              onClick={() => setTheme("dark")}
            >
              <Moon size={17} /> 深色
            </button>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-intro">
          <Database size={24} weight="duotone" />
          <h2>数据与模型</h2>
        </div>
        {browserModelEnabled && <BrowserModelDownload />}
        <dl className="version-list">
          <div><dt>数据版本</dt><dd>{model?.data_version ?? "读取中"}</dd></div>
          <div><dt>模型版本</dt><dd>{model?.model_version ?? "读取中"}</dd></div>
          <div><dt>训练用户</dt><dd>{model?.training_users.toLocaleString() ?? "—"}</dd></div>
          <div><dt>训练评分</dt><dd>{model?.training_ratings.toLocaleString() ?? "—"}</dd></div>
          <div><dt>作品目录</dt><dd>{model?.catalog_items.toLocaleString() ?? "—"}</dd></div>
          {!browserModelEnabled && (
            <div><dt>索引状态</dt><dd><span className="status-dot" /> 已加载</dd></div>
          )}
        </dl>
      </section>
      <section className="settings-section">
        <div className="settings-intro">
          <ShieldCheck size={24} weight="duotone" />
          <h2>隐私</h2>
        </div>
        <div className="privacy-facts">
          <strong>资料、评分、收藏与推荐历史只保存在此设备</strong>
          <strong>服务器不接收这些数据</strong>
          <strong>Bangumi Access Token 不保存</strong>
        </div>
        <div className="settings-actions">
          {activeProfile && (
            <button
              className="button secondary"
              onClick={() => void exportProfile(activeProfile)}
            >
              <DownloadSimple size={18} /> 导出当前资料
            </button>
          )}
        </div>
      </section>
      {profiles.map((profile) => (
        <section className="settings-section danger-zone" key={profile.id}>
          <div className="settings-intro">
            <Trash size={24} />
            <h2>删除“{profile.name}”</h2>
          </div>
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button className="button danger-button">删除资料</button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="confirm-dialog" aria-describedby={`delete-${profile.id}`}>
                <Dialog.Title>确认删除本地资料</Dialog.Title>
                <Dialog.Description id={`delete-${profile.id}`}>
                  此操作会永久删除“{profile.name}”的全部本地记录，无法撤销。
                </Dialog.Description>
                <div>
                  <Dialog.Close className="button quiet">取消</Dialog.Close>
                  <Dialog.Close asChild>
                    <button
                      className="button danger-button"
                      onClick={() => void removeProfile(profile)}
                    >
                      永久删除
                    </button>
                  </Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </section>
      ))}
    </div>
  );
}

function BrowserModelDownload() {
  const [storedStatus, setStoredStatus] = useState<ModelStatus | null>(null);
  const liveStatus = useSyncExternalStore(
    subscribeBrowserModelStatus,
    browserModelStatusSnapshot,
    browserModelServerSnapshot,
  );
  useEffect(() => {
    void browserModelStatus().then(setStoredStatus).catch((reason) => {
      setStoredStatus({
        state: "error",
        downloadedBytes: 0,
        totalBytes: 3263204947,
        error: reason instanceof Error ? reason.message : "模型状态读取失败",
      });
    });
  }, []);

  const status = liveStatus ?? storedStatus;
  const percent = status?.totalBytes
    ? Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))
    : 0;
  const downloading = status?.state === "downloading";
  const ready = status?.state === "ready";

  function startDownload() {
    void downloadBrowserModel().then(setStoredStatus).catch(() => undefined);
  }

  return (
    <div className="model-download-settings">
      <div>
        <strong>
          {ready
            ? "模型已下载"
            : downloading
              ? `正在下载模型 ${percent}%`
              : status?.state === "error"
                ? "模型下载失败"
                : percent > 0
                  ? `模型已下载 ${percent}%`
                  : "模型尚未下载"}
        </strong>
        {!ready && (
          <progress value={percent} max={100} aria-label={`模型下载进度 ${percent}%`} />
        )}
      </div>
      {!ready && !downloading && (
        <button className="button primary" type="button" onClick={startDownload}>
          {percent > 0 ? "继续下载" : "下载模型"}
        </button>
      )}
    </div>
  );
}
