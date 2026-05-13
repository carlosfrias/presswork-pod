import Link from "next/link";
import { StatusBadge } from "@/components/status/StatusBadge";
import { formatRelative, formatUsd } from "@/lib/format";
import type { ListingWithDesign } from "@/lib/queries/listings";

export function ListingRow({ listing }: { listing: ListingWithDesign }) {
  const thumb = listing.design_packages?.image_url ?? listing.design_packages?.mockup_urls?.[0] ?? null;
  return (
    <Link
      href={`/listings/${listing.id}` as never}
      className="flex items-center gap-3 rounded-(--radius) border border-(--surface-line) bg-(--surface-2) p-2.5 transition-colors hover:bg-(--surface-3)"
    >
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-(--radius-sm) bg-(--surface-1)">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-(--text-primary)">
          {listing.title ?? <span className="text-(--text-faint)">(no title)</span>}
        </p>
        <p className="truncate text-xs text-(--text-muted)">
          {listing.trend_brief?.niche ?? "—"} · {formatRelative(listing.updated_at)}
        </p>
      </div>
      <span className="tabular text-sm text-(--accent-warm)">{formatUsd(listing.price_usd)}</span>
      <StatusBadge status={listing.status} />
    </Link>
  );
}
