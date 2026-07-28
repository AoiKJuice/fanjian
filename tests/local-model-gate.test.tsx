import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LocalModelGate } from "../app/components/local-model-gate";

const mocks = vi.hoisted(() => ({
  loadLocalHealth: vi.fn(),
}));

vi.mock("../app/lib/api", () => ({
  loadLocalHealth: mocks.loadLocalHealth,
}));

function renderGate() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retryDelay: 0 },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalModelGate />
    </QueryClientProvider>,
  );
}

describe("local model gate", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.loadLocalHealth.mockReset();
  });

  it("shows the Windows download when the local model is unavailable", async () => {
    mocks.loadLocalHealth.mockRejectedValue(new Error("offline"));
    renderGate();

    expect(
      await screen.findByRole("dialog", {}, { timeout: 3000 }),
    ).toHaveTextContent("在本机运行番鉴");
    expect(
      screen.getByRole("link", { name: "下载本地版" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/AoiKJuice/fanjian/releases/download/v0.1.0/fanjian-windows-v0.1.0.zip",
    );
  });

  it("does not interrupt the product when the local model is ready", async () => {
    mocks.loadLocalHealth.mockResolvedValue({
      status: "ok",
      model_version: "test",
      data_version: "test",
      catalog_items: 30677,
      training_users: 989203,
      training_ratings: 134143996,
    });
    renderGate();

    await vi.waitFor(() => {
      expect(mocks.loadLocalHealth).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
