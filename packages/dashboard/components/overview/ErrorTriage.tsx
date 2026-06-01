import { retryBrief } from "@/lib/actions/scout";
import { retryDesign } from "@/lib/actions/design";
import { retryListing } from "@/lib/actions/listings";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelative } from "@/lib/format";
import type { ErrorTriageRow } from "@/lib/queries/overview";

type Source = ErrorTriageRow["source"];

const SOURCE_LABEL: Record<Source, string> = {
  trend_briefs: "Scout",
  design_packages: "Design",
  listings: "Listing",
  orders: "Ledger",
};

/** Ordered display sections so the most actionable (Design — no auto-retry) comes first. */
const SOURCE_ORDER: Source[] = ["design_packages", "trend_briefs", "listings", "orders"];

// Matches the badge style in RecentErrors.tsx.
const SOURCE_BADGE =
  "rounded-(--radius-sm) bg-(--accent-bad)/15 px-1.5 py-0.5 font-medium text-(--accent-bad)";

/** The correct server action per requeueable source. */
function RequeueForm({ row }: { row: ErrorTriageRow }) {
  const action =
    row.source === "trend_briefs"
      ? retryBrief
      : row.source === "design_packages"
        ? retryDesign
        : retryListing;

  return (
    <form action={action}>
      <input type="hidden" name="id" value={row.id} />
      <SubmitButton
        idleLabel="Requeue"
        pendingLabel="Requeueing…"
        variant="secondary"
        size="sm"
      />
    </form>
  );
}

interface ErrorRowProps {
  row: ErrorTriageRow;
}

function ErrorRowItem({ row }: ErrorRowProps) {
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className={SOURCE_BADGE}>{SOURCE_LABEL[row.source]}</span>
            <span className="font-mono text-(--text-faint)">{row.id.slice(0, 8)}</span>
            {row.context && (
              <span className="truncate text-(--text-muted)" title={row.context}>
                {row.context}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-(--text-secondary)">
            {row.error_message ?? "(no error message recorded)"}
          </p>
          <div className="mt-1 flex items-center gap-3 text-xs text-(--text-muted)">
            <time suppressHydrationWarning className="tabular">
              {formatRelative(row.updated_at)}
            </time>
            {row.retry_count > 0 && (
              <span>
                {row.retry_count} retr{row.retry_count === 1 ? "y" : "ies"}
              </span>
            )}
            {!row.requeueable && (
              <span className="italic">Ledger re-polls automatically</span>
            )}
          </div>
        </div>
        {row.requeueable && (
          <div className="shrink-0">
            <RequeueForm row={row} />
          </div>
        )}
      </div>
    </li>
  );
}

interface ErrorGroupProps {
  source: Source;
  rows: ErrorTriageRow[];
}

function ErrorGroup({ source, rows }: ErrorGroupProps) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-(--text-muted)">
        {SOURCE_LABEL[source]}{" "}
        <span className="font-normal text-(--text-faint)">({rows.length})</span>
      </h3>
      <ul className="mt-2 divide-y divide-(--surface-line)">
        {rows.map((row) => (
          <ErrorRowItem key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

interface ErrorTriageProps {
  errors: ErrorTriageRow[];
}

export function ErrorTriage({ errors }: ErrorTriageProps) {
  if (errors.length === 0) {
    return <EmptyState title="No errors. Pipeline healthy." />;
  }

  const bySource = new Map<Source, ErrorTriageRow[]>();
  for (const source of SOURCE_ORDER) {
    bySource.set(source, []);
  }
  for (const row of errors) {
    bySource.get(row.source)?.push(row);
  }

  const sections = SOURCE_ORDER.filter((s) => (bySource.get(s)?.length ?? 0) > 0);

  return (
    <div className="flex flex-col gap-6">
      {sections.map((source) => (
        <ErrorGroup key={source} source={source} rows={bySource.get(source) ?? []} />
      ))}
    </div>
  );
}
