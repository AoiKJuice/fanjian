"use client";

import {
  ArrowClockwise,
  DownloadSimple,
  HardDrives,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { loadLocalHealth } from "../lib/api";
import { browserModelEnabled } from "../lib/browser-mode";
import {
  browserModelStatus,
  downloadBrowserModel,
} from "../lib/model-client";
import type { ModelDownloadProgress } from "../lib/model-types";

const WINDOWS_PACKAGE =
  "https://github.com/AoiKJuice/fanjian/releases/download/" +
  "v0.1.0/fanjian-windows-v0.1.0.zip";

export function LocalModelGate() {
  if (browserModelEnabled) return <BrowserModelGate />;
  return <DesktopModelGate />;
}

function BrowserModelGate() {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const status = useQuery({
    queryKey: ["browser-model-status"],
    queryFn: browserModelStatus,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const ready = status.data?.state === "ready";
  if (status.isPending || ready || dismissed) return null;

  async function download() {
    setDownloadError(false);
    setProgress({
      state: "downloading",
      downloadedBytes: status.data?.downloadedBytes ?? 0,
      totalBytes: status.data?.totalBytes ?? 3263204947,
    });
    try {
      await downloadBrowserModel(setProgress);
      await status.refetch();
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== "browser-model-status",
      });
    } catch (reason) {
      console.error("模型下载失败", reason);
      setProgress(null);
      setDownloadError(true);
    }
  }

  const percent = progress?.totalBytes
    ? Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;

  return (
    <div className="model-gate-backdrop">
      <section
        className="model-gate model-download-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-gate-title"
      >
        {progress ? (
          <>
            <h1 id="model-gate-title">正在下载模型 {percent}%</h1>
            <progress value={percent} max={100} aria-label={`模型下载进度 ${percent}%`} />
          </>
        ) : (
          <>
            <h1 id="model-gate-title">
              {downloadError
                ? "模型下载失败"
                : <>
                    即将下载约 3.03 GiB <span className="model-file-label">模型文件</span>
                  </>}
            </h1>
            <div className="model-gate-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setDismissed(true)}
              >
                取消
              </button>
              <button className="button primary" type="button" onClick={download}>
                {downloadError ? "重新下载" : "确认下载"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function DesktopModelGate() {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ["local-health"],
    queryFn: loadLocalHealth,
    retry: 1,
    refetchOnWindowFocus: true,
  });

  if (health.isPending || health.isSuccess) return null;

  async function detectLocalModel() {
    const result = await health.refetch();
    if (result.isSuccess) {
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== "local-health",
      });
    }
  }

  return (
    <div className="model-gate-backdrop">
      <section
        className="model-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-gate-title"
      >
        <HardDrives size={42} weight="duotone" aria-hidden />
        <h1 id="model-gate-title">在本机运行番鉴</h1>
        <strong className="model-gate-size">
          完整模型约 1.48 GiB
        </strong>
        <ol>
          <li>下载并解压 Windows 版</li>
          <li>双击“启动番鉴.cmd”</li>
        </ol>
        <div className="model-gate-actions">
          <a
            className="button primary"
            href={WINDOWS_PACKAGE}
            download
          >
            <DownloadSimple size={20} weight="bold" />
            下载本地版
          </a>
          <button
            className="button secondary"
            type="button"
            onClick={detectLocalModel}
            disabled={health.isFetching}
          >
            <ArrowClockwise size={19} />
            重新检测
          </button>
        </div>
      </section>
    </div>
  );
}
