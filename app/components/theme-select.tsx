"use client";

import { CaretDown, Check } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Select } from "radix-ui";

export type SelectOption = {
  value: string;
  label: string;
};

export function ThemeSelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  icon,
  compact = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger
        className={`theme-select-trigger${compact ? " compact" : ""}`}
        aria-label={ariaLabel}
      >
        {icon}
        <Select.Value />
        <Select.Icon className="theme-select-caret">
          <CaretDown size={15} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="theme-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <Select.Viewport className="theme-select-viewport">
            {options.map((option) => (
              <Select.Item
                className="theme-select-item"
                key={option.value}
                value={option.value}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="theme-select-indicator">
                  <Check size={15} weight="bold" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
