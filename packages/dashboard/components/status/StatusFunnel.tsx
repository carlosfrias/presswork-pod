import { cn } from "@/lib/cn";

export interface StatusCount {
  status: string;
  count: number;
}

interface StatusFunnelProps {
  counts: StatusCount[];
  /** Status keys in the order they should appear; unknown statuses tack onto the end. */
  order?: string[];
}

const VAR: Record<string, string> = {
  pending: "var(--status-pending)",
  needs_review: "var(--status-review)",
  approved: "var(--accent-good)",
  processing: "var(--status-processing)",
  done: "var(--status-done)",
  error: "var(--status-error)",
  pending_publish: "var(--accent-warm)",
  publishing: "var(--status-publishing)",
  active: "var(--status-active)",
  logged: "var(--status-done)",
};

export function StatusFunnel({ counts, order }: StatusFunnelProps) {
  const total = counts.reduce((a, b) => a + b.count, 0) || 1;
  const desired = order ?? ["pending", "processing", "done", "error"];
  const ordered = [
    ...desired.flatMap((s) => counts.filter((c) => c.status === s)),
    ...counts.filter((c) => !desired.includes(c.status)),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-2 overflow-hidden rounded-(--radius-sm) bg-(--surface-2)"
        role="img"
        aria-label={`Status distribution: ${ordered.map((c) => `${c.count} ${c.status}`).join(", ")}`}
      >
        {ordered.map((c) => (
          <span
            key={c.status}
            className="h-full transition-all"
            style={{
              width: `${(c.count / total) * 100}%`,
              background: VAR[c.status] ?? "var(--surface-3)",
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {ordered.map((c) => (
          <span key={c.status} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: VAR[c.status] ?? "var(--surface-3)" }}
            />
            <span className="text-(--text-muted)">{c.status}</span>
            <span className={cn("tabular text-(--text-primary)")}>{c.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
