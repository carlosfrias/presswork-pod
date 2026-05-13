import { formatNumber, formatUsd } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import type { TopListing } from "@/lib/queries/ledger";

export function TopListingsTable({ rows }: { rows: TopListing[] }) {
  if (rows.length === 0) return <EmptyState title="No orders yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium tracking-wider text-(--text-muted) uppercase">
            <th className="py-2 pr-4">Listing</th>
            <th className="py-2 pr-4 text-right">Orders</th>
            <th className="py-2 pr-4 text-right">Revenue</th>
            <th className="py-2 text-right">Margin</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--surface-line)">
          {rows.map((r) => (
            <tr key={r.listing_id ?? "_unknown"}>
              <td className="py-2.5 pr-4">
                {r.etsy_listing_id ? (
                  <a
                    href={`https://www.etsy.com/listing/${r.etsy_listing_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-(--text-primary) hover:underline"
                  >
                    {r.title ?? `Listing ${r.etsy_listing_id}`}
                  </a>
                ) : (
                  <span className="text-(--text-secondary)">{r.title ?? "—"}</span>
                )}
              </td>
              <td className="py-2.5 pr-4 text-right tabular">{formatNumber(r.order_count)}</td>
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
