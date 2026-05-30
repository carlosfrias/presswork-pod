import "server-only";
import { AgentRunStatus } from "@/components/triggers/AgentRunStatus";
import { TriggerButton } from "@/components/triggers/TriggerButton";
import {
  type Agent,
  getIsListingAgentRunning,
  getLastAgentRun,
  getPendingWorkCount,
} from "@/lib/actions/triggers";

const CLI_COMMAND: Record<Agent, string> = {
  scout: "python -m packages.scout.main",
  design: "python -m packages.design.main",
  listing: "npm run --workspace packages/listing dev",
  ledger: "npm run --workspace packages/ledger poll-receipts",
};

const LABEL: Record<Agent, string> = {
  scout: "Run Scout",
  design: "Run Design",
  listing: "Run Listing",
  ledger: "Run Ledger",
};

export async function AgentRunButton({ agent }: { agent: Agent }) {
  const enabled = process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED === "true";
  // Run last-run lookup, pending count, and (for listing) running check in
  // parallel — all hit Supabase, no reason to serialize.
  const [last, pendingCount, isRunning] = await Promise.all([
    getLastAgentRun(agent),
    getPendingWorkCount(agent),
    agent === "listing" ? getIsListingAgentRunning() : Promise.resolve(false),
  ]);

  // design and listing have upstream queues (design_packages / listings rows
  // awaiting processing). scout and ledger are on-demand with no queue.
  const hasQueue = agent === "design" || agent === "listing";

  return (
    <div className="flex flex-col items-end gap-1">
      {enabled ? (
        <TriggerButton
          agent={agent}
          label={LABEL[agent]}
          pendingCount={pendingCount}
          locked={isRunning}
          hasQueue={hasQueue}
        />
      ) : (
        <details className="text-xs">
          <summary className="cursor-pointer rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-3 py-1.5 text-(--text-secondary) hover:bg-(--surface-3)">
            {LABEL[agent]} — locally
          </summary>
          <pre className="mt-1 rounded-(--radius-sm) bg-(--surface-2) p-2 text-[11px] font-mono text-(--text-secondary)">
            {CLI_COMMAND[agent]}
          </pre>
        </details>
      )}
      <AgentRunStatus agent={agent} initial={last} />
    </div>
  );
}
