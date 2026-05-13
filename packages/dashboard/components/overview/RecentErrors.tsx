import Link from "next/link";
import { formatRelative } from "@/lib/format";
import type { RecentError } from "@/lib/queries/overview";

const SOURCE_LABEL: Record<RecentError["source"], string> = {
  trend_briefs: "Scout",
  design_packages: "Design",
  listings: "Listing",
  orders: "Ledger",
};

export function RecentErrors({ errors }: { errors: RecentError[] }) {
  if (errors.length === 0) {
    return <p className="text-xs text-(--text-muted)">No errors. Pipeline healthy.</p>;
  }
  return (
    <ul className="divide-y divide-(--surface-line)">
      {errors.map((e) => (
        <li key={`${e.source}-${e.id}`} className="py-2.5">
          <Link
            href={e.href as never}
            className="group block focus-visible:outline-2 focus-visible:outline-(--accent-warm)"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-(--radius-sm) bg-(--accent-bad)/15 px-1.5 py-0.5 font-medium text-(--accent-bad)">
                    {SOURCE_LABEL[e.source]}
                  </span>
                  <span className="font-mono text-(--text-faint)">{e.id.slice(0, 8)}</span>
                </div>
                <p className="mt-1 truncate text-sm text-(--text-secondary) group-hover:text-(--text-primary)">
                  {e.error_message ?? "(no error message recorded)"}
                </p>
              </div>
              <time className="shrink-0 text-xs text-(--text-muted) tabular">
                {formatRelative(e.updated_at)}
              </time>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
