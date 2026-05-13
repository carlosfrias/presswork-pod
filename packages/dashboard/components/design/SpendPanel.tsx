import { formatUsd, formatNumber } from "@/lib/format";
import type { DesignSpend } from "@/lib/queries/design";

export function SpendPanel({ spend }: { spend: DesignSpend }) {
  return (
    <div className="flex flex-col gap-3">
      <Row label="FLUX Pro 1.1" value={formatUsd(spend.flux_pro_usd)} />
      <Row label="Aura SR (upscaler)" value={formatUsd(spend.aura_sr_usd)} />
      <Row label="BiRefNet (bg remove)" value={formatUsd(spend.birefnet_usd)} />
      <div className="h-px bg-(--surface-line)" />
      <Row label="Total fal.ai" value={formatUsd(spend.total_usd)} accent="warm" />
      <Row label="Designs done" value={formatNumber(spend.designs_done)} />
      {spend.avg_cost_per_design != null && (
        <Row
          label="Avg cost / done design"
          value={formatUsd(spend.avg_cost_per_design)}
          muted
        />
      )}
      <Row label="Cache hits" value={formatNumber(spend.cache_hits)} accent="good" />
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: "warm" | "good";
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className={muted ? "text-(--text-muted)" : "text-(--text-secondary)"}>{label}</span>
      <span
        className={
          accent === "warm"
            ? "tabular text-(--accent-warm) font-semibold"
            : accent === "good"
              ? "tabular text-(--accent-good)"
              : "tabular text-(--text-primary)"
        }
      >
        {value}
      </span>
    </div>
  );
}
