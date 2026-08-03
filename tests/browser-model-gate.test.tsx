import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Snapshot = null | {
    state: "missing" | "downloading" | "ready" | "error";
    downloadedBytes: number;
    totalBytes: number;
  };
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = null;
  return {
    browserModelStatus: vi.fn(),
    downloadBrowserModel: vi.fn(),
    subscribeBrowserModelStatus(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    browserModelStatusSnapshot() {
      return snapshot;
    },
    browserModelServerSnapshot() {
      return null;
    },
    publish(status: NonNullable<Snapshot>) {
      snapshot = status;
      listeners.forEach((listener) => listener());
    },
    resetStatus() {
      snapshot = null;
      listeners.clear();
    },
  };
});

vi.mock("../app/lib/browser-mode", () => ({ browserModelEnabled: true }));
vi.mock("../app/lib/model-client", () => mocks);
vi.mock("../app/lib/api", () => ({ loadLocalHealth: vi.fn() }));

import { LocalModelGate } from "../app/components/local-model-gate";

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalModelGate />
    </QueryClientProvider>,
  );
}

describe("browser model gate", () => {
  beforeEach(() => {
    mocks.browserModelStatus.mockReset();
    mocks.downloadBrowserModel.mockReset();
    mocks.resetStatus();
    mocks.browserModelStatus.mockResolvedValue({
      state: "missing",
      downloadedBytes: 0,
      totalBytes: 3263204947,
    });
  });

  afterEach(cleanup);

  it("asks for confirmation with the requested copy", async () => {
    renderGate();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("即将下载约 3.03 GiB 模型文件");
    expect(screen.getByRole("button", { name: "取消" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认下载" })).toBeVisible();
  });

  it("shows download progress after confirmation", async () => {
    mocks.downloadBrowserModel.mockImplementation(() => {
      mocks.publish({
        state: "downloading",
        downloadedBytes: 1631602473,
        totalBytes: 3263204947,
      });
      return new Promise(() => undefined);
    });
    renderGate();
    fireEvent.click(await screen.findByRole("button", { name: "确认下载" }));
    expect(await screen.findByText("正在下载模型 49%")).toBeVisible();
    expect(screen.getByRole("button", { name: "后台下载" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "后台下载" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
