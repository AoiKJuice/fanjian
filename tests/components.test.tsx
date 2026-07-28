import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnimeCover } from "../app/components/anime-cover";
import { Confidence, StatePanel } from "../app/components/ui";

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
