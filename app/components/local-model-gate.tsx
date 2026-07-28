"use client";

import {
  ArrowClockwise,
  DownloadSimple,
  HardDrives,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loadLocalHealth } from "../lib/api";

const WINDOWS_PACKAGE =
  "https://github.com/AoiKJuice/fanjian/releases/download/" +
  "v0.1.0/fanjian-windows-v0.1.0.zip";
const SERVER_MODE = process.env.NEXT_PUBLIC_SERVER_MODE === "1";

export function LocalModelGate() {
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
        <h1 id="model-gate-title">
          {SERVER_MODE ? "服务暂时不可用" : "在本机运行番鉴"}
        </h1>
        {!SERVER_MODE && (
          <>
            <strong className="model-gate-size">
              完整模型约 1.48 GiB
            </strong>
            <ol>
              <li>下载并解压 Windows 版</li>
              <li>双击“启动番鉴.cmd”</li>
            </ol>
          </>
        )}
        <div className="model-gate-actions">
          {!SERVER_MODE && (
            <a
              className="button primary"
              href={WINDOWS_PACKAGE}
              download
            >
              <DownloadSimple size={20} weight="bold" />
              下载本地版
            </a>
          )}
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
