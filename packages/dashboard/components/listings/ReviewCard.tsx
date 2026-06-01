import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MockupCarousel } from "./MockupCarousel";
import { ComplianceChecks } from "./ComplianceChecks";
import { CopyEditor } from "./CopyEditor";
import { DynamicMockupsTrigger } from "./DynamicMockupsTrigger";
import { formatRelative, formatUsd } from "@/lib/format";
import {
  approveListingWithCopy,
  recreatePrintifyProduct,
  regenerateCopy,
  rejectListing,
  retryListing,
} from "@/lib/actions/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

/**
 * Inline review/edit card. Used by both the Review queue (status='needs_review')
 * and the Errors card (status='error') on the listings page. Mode-aware:
 *
 *   - needs_review: editor + Approve / Regenerate copy / Reject / Open detail.
 *   - error: editor (error mode) + the error_message inline + Retry from error
 *     / Reject / Open detail. Save updates the row + clears error_message;
 *     Retry from error puts it back in the queue.
 */
export function ReviewCard({ listing }: { listing: ListingWithDesign }) {
  const isError = listing.status === "error";
  const editorMode = isError ? "error" : "needs_review";

  return (
    <article
      className={`rounded-(--radius-lg) border p-5 ${
        isError
          ? "border-(--accent-bad)/40 bg-(--accent-bad)/5"
          : "border-(--surface-line) bg-(--surface-1)"
      }`}
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-3">
          <MockupCarousel
            imageUrl={listing.design_packages?.image_url ?? null}
            mockupUrls={listing.design_packages?.mockup_urls ?? null}
            alt={listing.title ?? "Listing"}
          />
          <DynamicMockupsTrigger
            listingId={listing.id}
            blueprintId={listing.design_packages?.printify_blueprint_id ?? null}
          />
          <div className="text-xs text-(--text-muted)">
            <div>
              Niche:{" "}
              <span className="text-(--text-primary)">
                {listing.trend_brief?.niche ?? "—"}
              </span>
            </div>
            <div className="font-mono">{listing.id.slice(0, 8)}</div>
            <div suppressHydrationWarning>{formatRelative(listing.updated_at)}</div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <header className="flex items-center gap-3 text-xs text-(--text-muted)">
            <span className="tabular text-(--accent-warm) font-semibold text-sm">
              {formatUsd(listing.price_usd)}
            </span>
            <span>·</span>
            <span>{listing.trend_brief?.niche ?? "—"}</span>
            {isError && (
              <span className="ml-auto rounded-(--radius-sm) bg-(--accent-bad)/15 px-2 py-0.5 text-xs font-medium text-(--accent-bad)">
                error · retry {listing.retry_count}
              </span>
            )}
          </header>

          {isError && listing.error_message && (
            <p className="whitespace-pre-wrap break-words rounded-(--radius-sm) border border-(--accent-bad)/30 bg-(--accent-bad)/10 p-3 text-xs leading-relaxed text-(--accent-bad)">
              {listing.error_message}
            </p>
          )}

          <CopyEditor
            listingId={listing.id}
            initialTitle={listing.title}
            initialDescription={listing.description}
            initialTags={listing.tags}
            initialPriceUsd={listing.price_usd}
            mode={editorMode}
            compact
            approveAction={!isError ? approveListingWithCopy : undefined}
          />

          <ComplianceChecks
            title={listing.title}
            description={listing.description}
            tags={listing.tags}
            priceUsd={listing.price_usd}
            mockupsFromActualDesign={
              listing.design_packages?.mockups_from_actual_design ?? false
            }
          />

          <div className="mt-1 flex flex-wrap gap-2">
            {isError && (
              <form action={retryListing}>
                <input type="hidden" name="id" value={listing.id} />
                <Button type="submit" variant="primary" size="sm">
                  Retry from error
                </Button>
              </form>
            )}
            {!isError && (
              <form action={regenerateCopy}>
                <input type="hidden" name="id" value={listing.id} />
                <Button type="submit" variant="secondary" size="sm">
                  Regenerate copy
                </Button>
              </form>
            )}
            {!isError && (
              <form action={recreatePrintifyProduct}>
                <input type="hidden" name="id" value={listing.id} />
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  title="Clears printify_product_id and re-runs the Printify product creation + mockup fetch on the next Listing agent run."
                  idleLabel="Recreate Printify product"
                  pendingLabel="Recreating…"
                />
              </form>
            )}
            <details className="ml-auto">
              <summary className="cursor-pointer rounded-(--radius-sm) bg-(--surface-2) px-3 py-1.5 text-xs text-(--text-secondary) hover:text-(--text-primary)">
                Reject…
              </summary>
              <form action={rejectListing} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="id" value={listing.id} />
                <div className="flex items-center gap-2">
                  <input
                    name="reason"
                    placeholder="Reason (logged to error_message)"
                    className="h-8 w-64 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-xs text-(--text-primary)"
                  />
                  <Button type="submit" variant="danger" size="sm">
                    Reject
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-xs text-(--text-muted)">
                  <input type="checkbox" name="send_design_back" />
                  <span>
                    Design issue — also flip design back to needs_review and free it for re-listing
                  </span>
                </label>
              </form>
            </details>
            <Link
              href={`/listings/${listing.id}` as never}
              className="self-center text-xs text-(--text-muted) hover:text-(--text-primary)"
            >
              Open detail →
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
