"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteListing } from "@/lib/actions/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

interface Props {
  listing: ListingWithDesign;
  /** Pass <ReviewCard listing={l} /> from the server parent — client components
   *  cannot import server components directly without pulling server-only deps
   *  (node:fs via @presswork/shared) into the client bundle. */
  children: React.ReactNode;
}

export function CollapsibleErrorCard({ listing, children }: Props) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const thumb = listing.design_packages?.image_url ?? null;

  return (
    <div className="overflow-hidden rounded-(--radius-lg) border border-(--accent-bad)/40">
      {/* Summary row — always visible */}
      <div
        className="flex cursor-pointer items-center gap-3 p-3 hover:bg-(--accent-bad)/5"
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        {/* Thumbnail */}
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-(--radius-sm) bg-(--surface-2)">
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

        {/* Title + error snippet */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-(--text-primary)">
            {listing.title ?? <span className="text-(--text-faint)">(no title)</span>}
          </p>
          {listing.error_message && (
            <p className="truncate text-xs text-(--accent-bad)">{listing.error_message}</p>
          )}
        </div>

        {/* Clear button — stops propagation so the click doesn't toggle open */}
        <div
          className="flex shrink-0 items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {clearing ? (
            <form action={deleteListing} className="flex items-center gap-2">
              <input type="hidden" name="id" value={listing.id} />
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-(--text-muted)">
                <input type="checkbox" name="send_design_back" defaultChecked />
                <span>Free design</span>
              </label>
              <SubmitButton size="sm" variant="danger" idleLabel="Confirm delete" pendingLabel="Deleting…" />
              <button
                type="button"
                onClick={() => setClearing(false)}
                className="text-xs text-(--text-faint) hover:text-(--text-secondary)"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setClearing(true)}
              className="rounded-(--radius-sm) border border-(--accent-bad)/30 px-2.5 py-1 text-xs text-(--accent-bad) hover:bg-(--accent-bad)/10"
            >
              Clear…
            </button>
          )}
        </div>

        {/* Chevron */}
        <span className="shrink-0 text-xs text-(--text-faint)">{open ? "▲" : "▼"}</span>
      </div>

      {/* Expanded body — children is <ReviewCard> rendered by the server parent */}
      {open && (
        <div className="border-t border-(--accent-bad)/20 p-5">
          {children}
        </div>
      )}
    </div>
  );
}
