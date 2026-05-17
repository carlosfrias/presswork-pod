import { formatUsd, formatRelative } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import type { OrderWithListing } from "@/lib/queries/ledger";

export function BelowThresholdTable({
  rows,
  threshold,
}: {
  rows: OrderWithListing[];
  threshold: number;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No orders below threshold"
        hint={`All orders are above ${formatUsd(threshold)} margin.`}
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium tracking-wider text-(--text-muted) uppercase">
            <th className="py-2 pr-4">Order</th>
            <th className="py-2 pr-4">Listing</th>
            <th className="py-2 pr-4 text-right">Sale</th>
            <th className="py-2 pr-4 text-right">Fees</th>
            <th className="py-2 pr-4 text-right">Print</th>
            <th className="py-2 pr-4 text-right">Margin</th>
            <th className="py-2 text-right">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--surface-line)">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="py-2.5 pr-4 font-mono text-xs text-(--text-faint)">
                {r.etsy_order_id.slice(0, 10)}
              </td>
              <td className="py-2.5 pr-4 text-(--text-secondary)">
                {r.listing_title ?? <span className="text-(--text-faint)">(unknown)</span>}
              </td>
              <td className="py-2.5 pr-4 text-right tabular">{formatUsd(r.sale_price_usd)}</td>
              <td className="py-2.5 pr-4 text-right tabular text-(--accent-warn)">
                {formatUsd(r.etsy_fees_usd)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular text-(--accent-cool)">
                {formatUsd(r.print_cost_usd)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular text-(--accent-bad)">
                {formatUsd(r.margin_usd)}
              </td>
              <td className="py-2.5 text-right text-xs text-(--text-muted)" suppressHydrationWarning>
                {formatRelative(r.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
