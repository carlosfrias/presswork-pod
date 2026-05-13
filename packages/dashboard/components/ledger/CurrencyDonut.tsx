import { formatNumber, formatUsd } from "@/lib/format";
import type { BreakdownRow } from "@/lib/queries/ledger";

export function CurrencyDonut({ rows }: { rows: BreakdownRow[] }) {
  const total = rows.reduce((a, b) => a + b.revenue_usd, 0) || 1;
  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-xs text-(--text-muted)">No orders in window.</p>
      ) : (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-(--surface-2)">
            {rows.map((r, i) => (
              <span
                key={r.key}
                className="h-full"
                style={{
                  width: `${(r.revenue_usd / total) * 100}%`,
                  background: `oklch(${72 - i * 6}% 0.12 ${(i * 50) % 360})`,
                }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1 text-xs">
            {rows.map((r) => (
              <li key={r.key} className="flex items-baseline justify-between">
                <span className="font-mono text-(--text-secondary)">{r.key}</span>
                <span className="text-(--text-muted) tabular">
                  {formatNumber(r.count)} orders · {formatUsd(r.revenue_usd)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
