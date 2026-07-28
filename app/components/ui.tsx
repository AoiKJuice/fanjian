import { ArrowRight, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatePanel({
  title,
  action,
}: {
  title: string;
  action?: { label: string; href: string };
}) {
  return (
    <section className="state-panel" role="status">
      <WarningCircle size={28} weight="duotone" aria-hidden />
      <h2>{title}</h2>
      {action && (
        <Link className="text-link" href={action.href}>
          {action.label} <ArrowRight aria-hidden />
        </Link>
      )}
    </section>
  );
}

export function Metric({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <div className="metric">
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

export function Confidence({ value }: { value: "高" | "中" | "低" }) {
  return (
    <span className={`confidence confidence-${value}`} aria-label={`${value}置信度`}>
      <span aria-hidden />
      {value}置信度
    </span>
  );
}
