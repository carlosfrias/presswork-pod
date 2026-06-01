import { type Db, getLogger, notifySlack } from "@presswork/shared";

// ---------------------------------------------------------------------------
// Staleness tier thresholds
//
// ORPHAN: statuses that represent mid-flight processing. A row that has been
// in {processing, publishing} too long almost certainly means the agent
// crashed mid-run without cleaning up. Default: 60 minutes.
//
// STALE: queue/gate statuses that should advance on their own after a human
// approves. A row that has been waiting too long likely indicates a silent
// pipeline stall. Default: 48 hours.
// ---------------------------------------------------------------------------

const ORPHAN_STATUSES = new Set(["processing", "publishing"]);

const WATCHDOG_ORPHAN_MINUTES = Number(
  process.env["WATCHDOG_ORPHAN_MINUTES"] ?? 60
);
const WATCHDOG_STALE_HOURS = Number(
  process.env["WATCHDOG_STALE_HOURS"] ?? 48
);

// ---------------------------------------------------------------------------
// Tables and statuses under surveillance (terminal rows excluded)
//
// Terminal statuses intentionally excluded:
//   trend_briefs:    done | error
//   design_packages: done | error
//   listings:        active | error
//   orders:          logged | error  (orders table excluded entirely — Ledger
//                                     re-polls idempotently; stuck rows there
//                                     are not actionable here)
// ---------------------------------------------------------------------------

const WATCHED_TABLES: ReadonlyArray<{
  table: string;
  statuses: ReadonlyArray<string>;
}> = [
  {
    table: "trend_briefs",
    statuses: [
      "needs_review",
      "needs_description",
      "approved",
      "pending",
      "processing",
    ],
  },
  {
    table: "design_packages",
    statuses: [
      "needs_review",
      "touch_up",
      "approved",
      "pending",
      "processing",
    ],
  },
  {
    table: "listings",
    statuses: [
      "pending",
      "needs_review",
      "pending_publish",
      "publishing",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StuckGroup {
  table: string;
  status: string;
  count: number;
  /** ISO timestamp of the oldest stuck updated_at */
  oldestUpdatedAt: string;
  /** Age of the oldest stuck row in full hours */
  oldestAgeHours: number;
}

export interface WatchdogSummary {
  totalStuck: number;
  findings: ReadonlyArray<StuckGroup>;
  /** Wall-clock instant this run used as "now" */
  ranAt: string;
}

export interface WatchdogOpts {
  /** Inject a deterministic "now" for tests. Defaults to the real wall-clock. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function thresholdForStatus(status: string): Date {
  const now = _now;
  if (ORPHAN_STATUSES.has(status)) {
    return new Date(now.getTime() - WATCHDOG_ORPHAN_MINUTES * 60 * 1000);
  }
  return new Date(now.getTime() - WATCHDOG_STALE_HOURS * 60 * 60 * 1000);
}

// Module-level "now" so helpers can access it without threading an extra param
// through every call. Set at the top of runWatchdog before any queries fire.
let _now: Date = new Date();

function ageHours(updatedAt: string, now: Date): number {
  const diffMs = now.getTime() - new Date(updatedAt).getTime();
  return diffMs / (1000 * 60 * 60);
}

function formatAgeLabel(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  return `${Math.round(hours)}h`;
}

// ---------------------------------------------------------------------------
// Core watchdog logic
// ---------------------------------------------------------------------------

export async function runWatchdog(
  db: Db,
  opts: WatchdogOpts = {}
): Promise<WatchdogSummary> {
  const log = getLogger("ledger");
  _now = opts.now ?? new Date();
  const ranAt = _now.toISOString();
  const findings: StuckGroup[] = [];

  for (const { table, statuses } of WATCHED_TABLES) {
    let rows: Array<{ id: string; status: string; updated_at: string }>;

    try {
      const { data, error } = await db
        .from(table)
        .select("id, status, updated_at")
        .in("status", statuses as string[]);

      if (error) {
        log.warn({
          agent: "ledger",
          action: "watchdog_query_error",
          table,
          error: error.message,
        });
        continue;
      }

      rows = (data ?? []) as Array<{
        id: string;
        status: string;
        updated_at: string;
      }>;
    } catch (err) {
      log.warn({
        agent: "ledger",
        action: "watchdog_query_exception",
        table,
        error: String(err),
      });
      continue;
    }

    // Group stuck rows by (table, status) — a row is "stuck" if its
    // updated_at is older than its tier threshold.
    const groupMap = new Map<
      string,
      { count: number; oldestUpdatedAt: string }
    >();

    for (const row of rows) {
      const threshold = thresholdForStatus(row.status);
      const rowDate = new Date(row.updated_at);

      if (rowDate >= threshold) {
        // Not yet stuck — within the allowed window.
        continue;
      }

      const key = `${table}::${row.status}`;
      const existing = groupMap.get(key);

      if (!existing) {
        groupMap.set(key, { count: 1, oldestUpdatedAt: row.updated_at });
      } else {
        const newCount = existing.count + 1;
        const oldestUpdatedAt =
          new Date(row.updated_at) < new Date(existing.oldestUpdatedAt)
            ? row.updated_at
            : existing.oldestUpdatedAt;
        groupMap.set(key, { count: newCount, oldestUpdatedAt });
      }
    }

    for (const [key, group] of groupMap) {
      const status = key.split("::")[1]!;
      const hours = ageHours(group.oldestUpdatedAt, _now);
      findings.push({
        table,
        status,
        count: group.count,
        oldestUpdatedAt: group.oldestUpdatedAt,
        oldestAgeHours: hours,
      });
    }
  }

  const totalStuck = findings.reduce((sum, f) => sum + f.count, 0);

  log.info({
    agent: "ledger",
    action: "watchdog",
    ranAt,
    totalStuck,
    findings: findings.map((f) => ({
      table: f.table,
      status: f.status,
      count: f.count,
      oldestAgeHours: Math.round(f.oldestAgeHours),
    })),
    status: totalStuck === 0 ? "healthy" : "warn",
  });

  if (totalStuck > 0) {
    const lines = findings.map(
      (f) =>
        `• ${f.table} / ${f.status}: ${f.count} row${f.count === 1 ? "" : "s"}, oldest ${formatAgeLabel(f.oldestAgeHours)}`
    );
    const message = `Pipeline watchdog: ${totalStuck} stuck row${totalStuck === 1 ? "" : "s"} detected\n${lines.join("\n")}`;
    await notifySlack(message, { severity: "warn" });
  }

  return { totalStuck, findings, ranAt };
}
