import "server-only";
import { Button } from "@/components/ui/Button";
import { AgentRunStatus } from "@/components/triggers/AgentRunStatus";
import {
  type Agent,
  getLastAgentRun,
  triggerAgent,
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
  const last = await getLastAgentRun(agent);

  return (
    <div className="flex flex-col items-end gap-1">
      {enabled ? (
        <form action={triggerAgent}>
          <input type="hidden" name="agent" value={agent} />
          <Button type="submit" variant="secondary" size="sm">
            {LABEL[agent]}
          </Button>
        </form>
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
