import { formatRelative } from "@/lib/format";
import type { ListingWithDesign } from "@/lib/queries/listings";

/**
 * Surfaces "stale artwork" when an active listing's source design has been
 * edited since the Printify product was last (re)created. Migration 049's
 * trigger handles the auto-rebuild for non-active listings (needs_review /
 * pending_publish get pulled back to pending automatically); active rows
 * are intentionally not auto-touched because that would be a destructive
 * server-side action against a live Etsy listing. Operator decides via
 * Recreate Printify product.
 *
 * Renders nothing when:
 *   - status !== 'active' (badge only matters for live listings)
 *   - design_synced_at is NULL (never synced — defensive; shouldn't happen
 *     for active listings that went through publishOne)
 *   - design.updated_at is NULL or <= design_synced_at (no drift)
 *   - the joined design_packages row is missing (orphan)
 */
export function StaleArtworkBadge({
  listing,
  variant = "row",
}: {
  listing: ListingWithDesign;
  variant?: "row" | "card";
}) {
  if (listing.status !== "active") return null;
  if (!listing.design_synced_at) return null;
  const dp = listing.design_packages;
  if (!dp?.updated_at) return null;
  const designUpdatedMs = new Date(dp.updated_at).getTime();
  const syncedMs = new Date(listing.design_synced_at).getTime();
  // 1s slack so the same-transaction write that sets design_synced_at
  // doesn't false-positive against design.updated_at when the timestamps
  // are the same to the millisecond.
  if (designUpdatedMs - syncedMs <= 1000) return null;

  const message = `Stale artwork — design updated ${formatRelative(dp.updated_at)} (after last Printify sync ${formatRelative(listing.design_synced_at)}). Click Recreate Printify product to rebuild.`;

  if (variant === "row") {
    return (
      <span
        className="rounded-(--radius-sm) bg-(--accent-warm)/15 px-2 py-0.5 text-xs font-medium text-(--accent-warm)"
        title={message}
      >
        Stale artwork
      </span>
    );
  }

  return (
    <p className="rounded-(--radius-sm) border border-(--accent-warm)/40 bg-(--accent-warm)/10 px-3 py-2 text-xs leading-relaxed text-(--accent-warm)">
      {message}
    </p>
  );
}
