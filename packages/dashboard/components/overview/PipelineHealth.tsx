import Link from "next/link";
import { cn } from "@/lib/cn";
import type { PipelineHealth as PipelineHealthRow } from "@/lib/queries/overview";

const HREF: Record<PipelineHealthRow["agent"], string> = {
  scout: "/scout",
  design: "/design",
  listing: "/listings",
  ledger: "/ledger",
};

const LABEL: Record<PipelineHealthRow["agent"], string> = {
  scout: "Scout",
  design: "Design",
  listing: "Listing",
  ledger: "Ledger",
};

export function PipelineHealthBar({ rows }: { rows: PipelineHealthRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      {rows.map((r) => {
        const total = Math.max(r.total, 1);
        return (
          <Link
            key={r.agent}
            href={HREF[r.agent] as never}
            className="group rounded-(--radius) border border-(--surface-line) bg-(--surface-2) p-3 transition-colors hover:bg-(--surface-3)"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-(--text-primary)">{LABEL[r.agent]}</span>
              <span className="tabular text-xs text-(--text-muted)">{r.total} in flight</span>
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-(--surface-1)">
              <Seg width={(r.needs_review / total) * 100} color="var(--status-review)" />
              <Seg width={(r.approved / total) * 100} color="var(--accent-warm)" />
              <Seg width={(r.processing / total) * 100} color="var(--status-processing)" />
              <Seg width={(r.error / total) * 100} color="var(--status-error)" />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              <Stat
                label="needs review"
                value={r.needs_review}
                color="var(--status-review)"
                className={r.needs_review > 0 ? "font-semibold text-(--text-primary)" : undefined}
              />
              <Stat label="approved" value={r.approved} color="var(--accent-warm)" />
              <Stat label="processing" value={r.processing} color="var(--status-processing)" />
              <Stat
                label="error"
                value={r.error}
                color="var(--status-error)"
                className={r.error > 0 ? "font-semibold" : undefined}
              />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Seg({ width, color }: { width: number; color: string }) {
  if (width <= 0) return null;
  return <span style={{ width: `${width}%`, background: color }} className="h-full" />;
}

function Stat({
  label,
  value,
  color,
  className,
}: {
  label: string;
  value: number;
  color: string;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1 text-(--text-muted)", className)}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
      <span className="tabular text-(--text-primary)">{value}</span>
    </span>
  );
}
