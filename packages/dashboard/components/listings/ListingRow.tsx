import Link from "next/link";
import { StatusBadge } from "@/components/status/StatusBadge";
import { StaleArtworkBadge } from "@/components/listings/StaleArtworkBadge";
import { formatRelative, formatUsd } from "@/lib/format";
import type { ListingWithDesign } from "@/lib/queries/listings";

export function ListingRow({ listing }: { listing: ListingWithDesign }) {
  const thumb = listing.design_packages?.image_url ?? null;
  const isError = listing.status === "error";
  return (
    <Link
      href={`/listings/${listing.id}` as never}
      className={`flex flex-col gap-2 rounded-(--radius) border p-2.5 transition-colors hover:bg-(--surface-3) ${
        isError
          ? "border-(--accent-bad)/40 bg-(--accent-bad)/5"
          : "border-(--surface-line) bg-(--surface-2)"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-(--radius-sm) bg-(--surface-1)">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="h-full w-full object-contain" loading="lazy" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-(--text-primary)">
            {listing.title ?? <span className="text-(--text-faint)">(no title)</span>}
          </p>
          <p className="truncate text-xs text-(--text-muted)">
            {listing.trend_brief?.niche ?? "—"} · <span suppressHydrationWarning>{formatRelative(listing.updated_at)}</span>
          </p>
        </div>
        <span className="tabular text-sm text-(--accent-warm)">{formatUsd(listing.price_usd)}</span>
        <StaleArtworkBadge listing={listing} variant="row" />
        <StatusBadge status={listing.status} />
      </div>
      {isError && listing.error_message && (
        <p className="line-clamp-3 break-words rounded-(--radius-sm) bg-(--accent-bad)/10 px-3 py-2 text-xs leading-relaxed text-(--accent-bad)">
          {listing.error_message}
        </p>
      )}
    </Link>
  );
}
