import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimeCover } from "../app/components/anime-cover";
import { RecommendationCard } from "../app/components/recommendation-card";
import { Confidence, StatePanel } from "../app/components/ui";
import type { Recommendation } from "../app/lib/data";

const recommendation: Recommendation = {
  anime: {
    mal_id: 1001,
    title_zh: "测试作品",
    title_native: "テスト",
    title_en: "Test",
    format: "TV",
    episodes: 12,
    year: 2025,
    release_status: "finished",
    synopsis: "",
    cover_index: 0,
    cover_url: null,
    platform_mean: 7,
    bangumi_score: 7.2,
    matched_tags: ["百合", "日常"],
  },
  rank_score: 0.5,
  affinity: 80,
  confidence: "中",
  support: 12,
  effective_sample_size: 8,
  reason: "",
  evidence: [],
  neighbor_distribution: {
    "1-4": 0,
    "5-6": 1,
    "7-8": 8,
    "9-10": 3,
  },
  risk: "",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shared interface components", () => {
  it("exposes cover alt text through an accessible image role", () => {
    render(<AnimeCover index={2} title="雪夜第七码" />);
    expect(screen.getByRole("img", { name: "雪夜第七码封面" })).toBeInTheDocument();
  });

  it("labels confidence without relying on color", () => {
    render(<Confidence value="高" />);
    expect(screen.getByLabelText("高置信度")).toHaveTextContent("高置信度");
  });

  it("renders a contextual empty state", () => {
    render(
      <StatePanel
        title="没有结果"
        action={{ label: "返回推荐", href: "/recommendations" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("没有结果");
    expect(screen.getByRole("link", { name: /返回推荐/ })).toHaveAttribute(
      "href",
      "/recommendations",
    );
  });
});

describe("recommendation feedback", () => {
  it("waits for the undo window before saving a hide", async () => {
    vi.useFakeTimers();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <RecommendationCard
        item={recommendation}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "不感兴趣" }),
    );
    expect(screen.getByRole("button", { name: "撤回" })).toBeVisible();
    expect(onFeedback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3199);
    });
    expect(onFeedback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onFeedback).toHaveBeenCalledWith("hide", 1001);
    expect(screen.getByText("正在更新推荐")).toBeVisible();
  });

  it("cancels the pending hide when undo is clicked", async () => {
    vi.useFakeTimers();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <RecommendationCard
        item={recommendation}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "不感兴趣" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "撤回" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(onFeedback).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "不感兴趣" }),
    ).toBeVisible();
  });
});
