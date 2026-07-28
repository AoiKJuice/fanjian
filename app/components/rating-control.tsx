"use client";

import { X } from "@phosphor-icons/react";

export function RatingControl({
  value,
  onChange,
  label,
  compact = false,
  disabled = false,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  function updateFromInput(rawValue: string) {
    if (rawValue === "") {
      onChange(null);
      return;
    }
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
      onChange(Math.min(10, Math.max(1, Math.round(numeric))));
    }
  }

  return (
    <div
      className={`rating-control${compact ? " compact" : ""}${
        value == null ? " empty" : ""
      }${disabled ? " disabled" : ""}`}
    >
      <label className="rating-number">
        <span className="sr-only">{label}，数字输入</span>
        <input
          type="number"
          min={1}
          max={10}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          value={value ?? ""}
          placeholder="—"
          aria-label={`${label}，数字输入`}
          onChange={(event) => updateFromInput(event.target.value)}
        />
        <span>/10</span>
      </label>
      <label className="rating-range">
        <span className="sr-only">{label}，滑条</span>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value ?? 5}
          disabled={disabled}
          aria-label={`${label}，滑条`}
          aria-valuetext={
            value == null ? "未评分，移动滑条即可评分" : `${value} 分`
          }
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      <button
        type="button"
        className="rating-clear"
        disabled={disabled || value == null}
        aria-label={`${label}，设为未评分`}
        title={disabled ? "计划观看不参与评分" : "设为未评分"}
        onClick={() => onChange(null)}
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}
