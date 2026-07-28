"use client";

import ReactECharts from "echarts-for-react";

export function InsightsChart({
  histogram,
}: {
  histogram: Record<string, number>;
}) {
  return (
    <ReactECharts
      style={{ height: 280 }}
      option={{
        animationDuration: 180,
        grid: { left: 36, right: 12, top: 16, bottom: 30 },
        xAxis: {
          type: "category",
          data: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          axisLine: { lineStyle: { color: "#a8a39d" } },
          axisLabel: { color: "#77716b" },
        },
        yAxis: { type: "value", show: false },
        tooltip: { trigger: "axis" },
        series: [
          {
            type: "bar",
            data: Array.from(
              { length: 10 },
              (_, index) => histogram[String(index + 1)] ?? 0,
            ),
            barMaxWidth: 28,
            itemStyle: { color: "#cf3e2b", borderRadius: [3, 3, 0, 0] },
          },
        ],
      }}
    />
  );
}
