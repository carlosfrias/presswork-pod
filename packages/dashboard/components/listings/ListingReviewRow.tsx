"use client";

import { useState } from "react";
import Link from "next/link";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { CopyEditor } from "@/components/listings/CopyEditor";
import { formatRelative, formatUsd } from "@/lib/format";
import { approveListing, rejectListing } from "@/lib/actions/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

interface Props {
  listing: ListingWithDesign;
  /** Number of failing compliance checks — computed server-side to avoid
   *  pulling @presswork/shared into the client bundle. */
  complianceFailCount: number;
  complianceFailingLabels: string;
}

export function ListingReviewRow({ listing, complianceFailCount, complianceFailingLabels }: Props) {
  const [expanded, setExpanded] = useState(false);

  const thumb = listing.design_packages?.image_url ?? null;

  const failCount = complianceFailCount;
  const failingLabels = complianceFailingLabels;

  return (
    <article className="overflow-hidden rounded-(--radius) border border-(--surface-line) bg-(--surface-1)">
      {/* Collapsed row */}
      <div className="flex items-center gap-3 p-2.5">
        {/* Thumbnail */}
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-(--radius-sm) bg-(--surface-2)">
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
        </div>

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-(--text-primary)">
            {listing.title ?? (
              <span className="text-(--text-faint)">(no title)</span>
            )}
          </p>
          <p className="truncate text-xs text-(--text-muted)">
            {listing.trend_brief?.niche ?? "—"} · <span suppressHydrationWarning>{formatRelative(listing.updated_at)}</span>
          </p>
        </div>

        {/* Compliance dot */}
        <div
          className="flex shrink-0 items-center gap-1"
          title={
            failCount === 0
              ? "All compliance checks pass"
              : `${failCount} failing: ${failingLabels}`
          }
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              failCount === 0 ? "bg-(--accent-good)" : "bg-(--accent-bad)"
            }`}
          />
          {failCount > 0 && (
            <span className="text-xs font-medium text-(--accent-bad)">{failCount}</span>
          )}
        </div>

        {/* Price */}
        <span className="shrink-0 tabular text-sm font-medium text-(--accent-warm)">
          {formatUsd(listing.price_usd)}
        </span>

        {/* Approve */}
        <form action={approveListing}>
          <input type="hidden" name="id" value={listing.id} />
          <SubmitButton size="sm" variant="primary" idleLabel="Approve" pendingLabel="…" />
        </form>

        {/* Expand/collapse toggle */}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 rounded-(--radius-sm) border border-(--surface-line) px-2 py-1.5 text-xs text-(--text-secondary) hover:border-(--surface-2) hover:text-(--text-primary)"
          aria-label={expanded ? "Collapse editor" : "Edit copy"}
        >
          {expanded ? "▲ Close" : "✎ Edit"}
        </button>

        {/* Detail link */}
        <Link
          href={`/listings/${listing.id}` as never}
          className="shrink-0 text-sm text-(--text-faint) hover:text-(--text-primary)"
          title="Open detail page"
        >
          ↗
        </Link>
      </div>

      {/* Expanded editor panel */}
      {expanded && (
        <div className="border-t border-(--surface-line) p-4">
          <CopyEditor
            listingId={listing.id}
            initialTitle={listing.title}
            initialDescription={listing.description}
            initialTags={listing.tags}
            initialPriceUsd={listing.price_usd}
            mode="needs_review"
            compact
          />
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--surface-line) pt-4">
            <form action={approveListing}>
              <input type="hidden" name="id" value={listing.id} />
              <SubmitButton size="sm" variant="primary" idleLabel="Approve" pendingLabel="Approving…" />
            </form>

            <details className="relative">
              <summary className="cursor-pointer list-none rounded-(--radius-sm) border border-(--surface-line) px-2.5 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-bad)/40 hover:text-(--accent-bad)">
                Reject…
              </summary>
              <div className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-(--radius) border border-(--surface-line) bg-(--surface-0) p-3 shadow-lg">
                <form action={rejectListing} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={listing.id} />
                  <input
                    name="reason"
                    placeholder="Reason (optional)"
                    className="h-8 w-full rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-xs text-(--text-primary)"
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-(--text-muted)">
                    <input type="checkbox" name="send_design_back" />
                    <span>Flip design back to needs_review</span>
                  </label>
                  <SubmitButton
                    size="sm"
                    variant="danger"
                    idleLabel="Reject"
                    pendingLabel="Rejecting…"
                  />
                </form>
              </div>
            </details>
          </div>
        </div>
      )}
    </article>
  );
}
