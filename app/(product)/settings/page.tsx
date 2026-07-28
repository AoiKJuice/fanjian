"use client";

import {
  Database,
  DownloadSimple,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";
import { Dialog } from "radix-ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, StatePanel } from "../../components/ui";
import { useTheme } from "../../providers";
import {
  deleteProfile,
  loadLibrary,
  loadModelCard,
  loadProfiles,
  type ModelCard,
  type Profile,
} from "../../lib/api";

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [model, setModel] = useState<ModelCard | null>(null);

  useEffect(() => {
    Promise.all([loadProfiles(), loadModelCard()])
      .then(([profileItems, modelCard]) => {
        setProfiles(profileItems);
        setModel(modelCard);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  async function exportProfile(profile: Profile) {
    try {
      const items = await loadLibrary(profile.id);
      const payload = JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          profile,
          ratings: items.map(({ mal_id, rating, status, updated_at }) => ({
            mal_id,
            rating,
            status,
            updated_at,
          })),
        },
        null,
        2,
      );
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
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
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
        {!profiles.length ? (
          <StatePanel
            title="还没有本地资料"
            action={{ label: "建立资料", href: "/onboarding" }}
          />
        ) : profiles.map((profile, index) => (
          <div className="profile-row" key={profile.id}>
            <span className="profile-avatar">{profile.name.slice(0, 1)}</span>
            <div>
              <strong>{profile.name}</strong>
              <span className="profile-stat">{profile.rating_count} 条评分</span>
            </div>
            {index === 0 && <span className="status-label current">当前</span>}
            <button
              className="button quiet"
              onClick={() => void exportProfile(profile)}
            >
              导出
            </button>
          </div>
        ))}
        <Link className="add-row" href="/onboarding">
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
        <dl className="version-list">
          <div><dt>数据版本</dt><dd>{model?.data_version ?? "读取中"}</dd></div>
          <div><dt>模型版本</dt><dd>{model?.model_version ?? "读取中"}</dd></div>
          <div><dt>训练用户</dt><dd>{model?.training_users.toLocaleString() ?? "—"}</dd></div>
          <div><dt>训练评分</dt><dd>{model?.training_ratings.toLocaleString() ?? "—"}</dd></div>
          <div><dt>作品目录</dt><dd>{model?.catalog_items.toLocaleString() ?? "—"}</dd></div>
          <div><dt>索引状态</dt><dd><span className="status-dot" /> 已加载</dd></div>
        </dl>
      </section>
      <section className="settings-section">
        <div className="settings-intro">
          <ShieldCheck size={24} weight="duotone" />
          <h2>隐私</h2>
        </div>
        <div className="privacy-facts">
          <strong>评分与反馈仅保存在本机</strong>
          <strong>Bangumi Access Token 不保存</strong>
        </div>
        <div className="settings-actions">
          {profiles[0] && (
            <button
              className="button secondary"
              onClick={() => void exportProfile(profiles[0])}
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
