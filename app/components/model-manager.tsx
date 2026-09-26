"use client";

import { Check, DownloadSimple, Pause, Play, Trash, X } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { activateBrowserModel, browserModelInventory, browserModelServerSnapshot, browserModelStatusSnapshot, cancelBrowserModel, downloadBrowserModel, pauseBrowserModel, removeBrowserModel, subscribeBrowserModelStatus } from "../lib/model-client";
import type { ModelInventory, ModelStatus } from "../lib/model-types";

export function modelBytes(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function modelStateLabel(status: ModelStatus) {
  return ({ missing: "未下载", paused: "已暂停", downloading: "下载中", verifying: "校验中", ready: "已下载", error: "下载失败" })[status.state];
}

export function ModelTransfer({ status, onChange, blocked = false }: { status: ModelStatus; onChange: () => void; blocked?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = status.manifest?.model_version;
  const transferring = status.state === "downloading" || status.state === "verifying";
  const percent = status.totalBytes ? Math.min(100, Math.floor(status.downloadedBytes / status.totalBytes * 100)) : 0;
  async function control(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); onChange(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  }
  function start() {
    setError("");
    void downloadBrowserModel(undefined, version).then(onChange).catch((reason) => setError(reason instanceof Error ? reason.message : "下载失败"));
  }
  return <div className="model-transfer">
    {status.state !== "missing" && status.state !== "ready" && <div className="model-transfer-progress">
      <div><strong>{modelStateLabel(status)} {percent}%</strong><span>{modelBytes(status.downloadedBytes)} / {modelBytes(status.totalBytes)}</span></div>
      <progress value={status.downloadedBytes} max={status.totalBytes || 1} aria-label={`模型下载进度 ${percent}%`} />
    </div>}
    {(error || status.error) && <div className="model-transfer-error" role="alert">{error || status.error}</div>}
    <div className="model-transfer-actions">
      {transferring ? <button className="button secondary" disabled={busy} onClick={() => void control(pauseBrowserModel)}><Pause size={17} />暂停</button>
        : status.state !== "ready" && <button className="button primary" disabled={busy || blocked} onClick={start}>
          {status.state === "missing" ? <DownloadSimple size={17} /> : <Play size={17} />}{status.state === "missing" ? "下载模型" : "继续下载"}
        </button>}
      {status.state !== "missing" && status.state !== "ready" && version && <button className="button quiet" disabled={busy} onClick={() => void control(() => cancelBrowserModel(version))}><X size={17} />取消下载</button>}
    </div>
  </div>;
}

export function BrowserModelManager() {
  const queryClient = useQueryClient();
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useSyncExternalStore(subscribeBrowserModelStatus, browserModelStatusSnapshot, browserModelServerSnapshot);
  const refresh = useCallback(() => {
    void browserModelInventory().then(setInventory).catch((reason) => setError(reason instanceof Error ? reason.message : "模型读取失败"));
  }, []);
  useEffect(refresh, [refresh, live?.state, live?.manifest?.model_version, live?.activeVersion]);
  async function changed() {
    refresh();
    await queryClient.invalidateQueries();
  }
  async function activate(version: string) {
    setBusy(true); setError("");
    try {
      await queryClient.cancelQueries();
      await activateBrowserModel(version);
      await changed();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "切换失败"); }
    finally { setBusy(false); }
  }
  async function remove(version: string) {
    setBusy(true); setError("");
    try { setInventory(await removeBrowserModel(version)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
    finally { setBusy(false); }
  }
  const downloading = live?.state === "downloading" || live?.state === "verifying";
  return <div className="model-version-list">
    {error && <div className="model-transfer-error" role="alert">{error}</div>}
    {!inventory && <div role="status">正在读取模型</div>}
    {inventory?.releases.map((release) => {
      const version = release.manifest.model_version;
      const active = inventory.activeVersion === version;
      const status = live?.manifest?.model_version === version ? live : release.status;
      return <article className={`model-version-row${active ? " active" : ""}`} key={version} aria-label={`${release.title} ${release.publishedAt}`}>
        <div className="model-version-heading">
          <div><h3>{release.title}</h3><div className="model-version-facts"><time>{release.publishedAt}</time><span>{modelBytes(release.manifest.total_bytes)}</span></div></div>
          {(active || status.state === "ready" || status.state === "missing") && <span className={`model-version-state${active ? " selected" : ""}`}>{active ? <><Check size={16} weight="bold" />当前使用</> : modelStateLabel(status)}</span>}
        </div>
        {status.state === "ready" ? <div className="model-transfer-actions">
          {!active && <button className="button secondary" disabled={busy} onClick={() => void activate(version)}>使用此版本</button>}
          {!active && <Dialog.Root><Dialog.Trigger asChild><button className="button quiet" disabled={busy} aria-label={`删除 ${release.title}`}><Trash size={17} /></button></Dialog.Trigger>
            <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="confirm-dialog" aria-describedby={undefined}>
              <Dialog.Title>删除 {release.title}？</Dialog.Title><div><Dialog.Close className="button quiet">保留</Dialog.Close><Dialog.Close className="button danger-button" onClick={() => void remove(version)}>删除模型</Dialog.Close></div>
            </Dialog.Content></Dialog.Portal></Dialog.Root>}
        </div> : <ModelTransfer status={{ ...status, manifest: release.manifest }} blocked={busy || (downloading && live?.manifest?.model_version !== version)} onChange={() => void changed()} />}
      </article>;
    })}
  </div>;
}
