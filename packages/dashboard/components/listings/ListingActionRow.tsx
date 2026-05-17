import Link from "next/link";
import { StatusBadge } from "@/components/status/StatusBadge";
import { StaleArtworkBadge } from "@/components/listings/StaleArtworkBadge";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatRelative, formatUsd } from "@/lib/format";
import { backUpListing, deleteListing } from "@/lib/actions/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

/**
 * Compact listing row with Back Up and Clear actions. Used for
 * pending_publish and active sections where the operator needs to
 * be able to revert or remove a listing without going to the detail page.
 *
 * Unlike ListingRow (which is a plain anchor), this component cannot wrap
 * everything in a Link since it contains interactive form elements.
 * Navigation to the detail page is via the title and thumbnail only.
 */
export function ListingActionRow({ listing }: { listing: ListingWithDesign }) {
  const thumb = listing.design_packages?.image_url ?? null;

  const backUpLabel =
    listing.status === "active" ? "Back up to pending" : "Back up to review";

  return (
    <article className="flex items-center gap-3 rounded-(--radius) border border-(--surface-line) bg-(--surface-2) p-2.5">
      {/* Thumbnail → detail */}
      <Link
        href={`/listings/${listing.id}` as never}
        className="h-12 w-12 shrink-0 overflow-hidden rounded-(--radius-sm) bg-(--surface-1)"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
            —
          </div>
        )}
      </Link>

      {/* Title + meta → detail */}
      <div className="min-w-0 flex-1">
        <Link href={`/listings/${listing.id}` as never} className="hover:underline">
          <p className="truncate text-sm font-medium text-(--text-primary)">
            {listing.title ?? <span className="text-(--text-faint)">(no title)</span>}
          </p>
        </Link>
        <p className="truncate text-xs text-(--text-muted)">
          {listing.trend_brief?.niche ?? "—"} · <span suppressHydrationWarning>{formatRelative(listing.updated_at)}</span>
        </p>
      </div>

      <span className="shrink-0 tabular text-sm text-(--accent-warm)">
        {formatUsd(listing.price_usd)}
      </span>
      <StaleArtworkBadge listing={listing} variant="row" />
      <StatusBadge status={listing.status} />

      {/* Etsy link for active listings */}
      {listing.status === "active" && listing.etsy_listing_id && (
        <a
          href={`https://www.etsy.com/listing/${listing.etsy_listing_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs text-(--text-faint) hover:text-(--text-primary)"
        >
          Etsy ↗
        </a>
      )}

      {/* Back up */}
      <form action={backUpListing}>
        <input type="hidden" name="id" value={listing.id} />
        <SubmitButton
          size="sm"
          variant="secondary"
          idleLabel={backUpLabel}
          pendingLabel="…"
        />
      </form>

      {/* Clear */}
      <details className="relative shrink-0">
        <summary className="cursor-pointer list-none rounded-(--radius-sm) border border-(--surface-line) px-2.5 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-bad)/40 hover:text-(--accent-bad)">
          Clear…
        </summary>
        <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-(--radius) border border-(--surface-line) bg-(--surface-0) p-3 shadow-lg">
          {listing.status === "active" && (
            <p className="mb-2 text-xs text-(--accent-warm)">
              This will deactivate the live Etsy listing.
            </p>
          )}
          <form action={deleteListing} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={listing.id} />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-(--text-muted)">
              <input type="checkbox" name="send_design_back" defaultChecked />
              <span>Free design for reopen</span>
            </label>
            <SubmitButton
              size="sm"
              variant="danger"
              idleLabel="Delete listing"
              pendingLabel="Deleting…"
            />
          </form>
        </div>
      </details>
    </article>
  );
}
