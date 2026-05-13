import { formatNumber, formatUsd } from "@/lib/format";
import type { NichePerformance } from "@/lib/queries/scout";
import { EmptyState } from "@/components/ui/EmptyState";

export function NicheTable({ rows }: { rows: NichePerformance[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No niche data yet" hint="Wait for Scout to write the first briefs." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium tracking-wider text-(--text-muted) uppercase">
            <th className="py-2 pr-4">Niche</th>
            <th className="py-2 pr-4 text-right">Briefs</th>
            <th className="py-2 pr-4 text-right">Designs</th>
            <th className="py-2 pr-4 text-right">Active listings</th>
            <th className="py-2 pr-4 text-right">Revenue</th>
            <th className="py-2 text-right">Margin</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--surface-line)">
          {rows.map((r) => (
            <tr key={r.niche} className="hover:bg-(--surface-2)">
              <td className="py-2.5 pr-4 font-medium text-(--text-primary)">{r.niche}</td>
              <td className="py-2.5 pr-4 text-right tabular text-(--text-secondary)">
                {formatNumber(r.briefs)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular text-(--text-secondary)">
                {formatNumber(r.designs)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular text-(--text-secondary)">
                {formatNumber(r.listings_active)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular text-(--accent-warm)">
                {formatUsd(r.revenue_usd)}
              </td>
              <td className="py-2.5 text-right tabular text-(--accent-good)">
                {formatUsd(r.margin_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
