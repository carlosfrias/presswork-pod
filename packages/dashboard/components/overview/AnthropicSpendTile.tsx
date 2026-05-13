import { KpiTile } from "@/components/ui/KpiTile";
import { formatUsd } from "@/lib/format";
import { getAnthropicSpend } from "@/lib/queries/balances";

export async function AnthropicSpendTile() {
  const spend = await getAnthropicSpend(30);
  if (!spend.ok) {
    return (
      <KpiTile
        label="Anthropic spend (30d)"
        value={<span className="text-(--text-faint) text-sm font-normal">unavailable</span>}
        size="md"
        accent="neutral"
        hint={<span className="text-(--accent-bad)">{spend.error}</span>}
      />
    );
  }
  const topAgent = spend.by_agent[0];
  return (
    <KpiTile
      label="Anthropic spend (30d)"
      value={formatUsd(spend.total_usd, { compact: true })}
      size="md"
      accent="cool"
      hint={
        topAgent ? (
          <span>
            tracked · top: <span className="font-mono">{topAgent.agent}</span>{" "}
            {formatUsd(topAgent.usd)} ({topAgent.calls} calls)
          </span>
        ) : (
          <span>tracked · no usage in window</span>
        )
      }
    />
  );
}
