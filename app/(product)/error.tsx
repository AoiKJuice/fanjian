"use client";

import { WarningCircle } from "@phosphor-icons/react";

export default function ProductError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <section className="state-panel" role="alert">
        <WarningCircle size={28} weight="duotone" />
        <h1>页面数据暂时不可用</h1>
        <button className="button primary" onClick={reset}>重新加载</button>
      </section>
    </div>
  );
}
