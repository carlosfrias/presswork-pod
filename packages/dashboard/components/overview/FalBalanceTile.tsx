import { KpiTile } from "@/components/ui/KpiTile";
import { formatUsd } from "@/lib/format";
import { getFalBalance } from "@/lib/queries/balances";

export async function FalBalanceTile() {
  const balance = await getFalBalance();
  if (!balance.ok) {
    return (
      <KpiTile
        label="fal.ai balance"
        value={<span className="text-(--text-faint) text-sm font-normal">unavailable</span>}
        size="md"
        accent="neutral"
        hint={<span className="text-(--accent-bad)">{balance.error}</span>}
      />
    );
  }
  const low = balance.current_balance_usd < 5;
  return (
    <KpiTile
      label="fal.ai balance"
      value={formatUsd(balance.current_balance_usd)}
      size="md"
      accent={low ? "bad" : "good"}
      hint={
        <span>
          live · {balance.username ?? "account"}
          {low && <span className="ml-2 text-(--accent-bad)">top up soon</span>}
        </span>
      }
    />
  );
}
