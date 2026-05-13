import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { MockupCarousel } from "./MockupCarousel";
import { ComplianceChecks } from "./ComplianceChecks";
import { formatRelative, formatUsd } from "@/lib/format";
import {
  approveListing,
  regenerateCopy,
  rejectListing,
} from "@/lib/actions/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

export function ReviewCard({ listing }: { listing: ListingWithDesign }) {
  return (
    <article className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-3">
          <MockupCarousel
            imageUrl={listing.design_packages?.image_url ?? null}
            mockupUrls={listing.design_packages?.mockup_urls ?? null}
            alt={listing.title ?? "Listing"}
          />
          <div className="text-xs text-(--text-muted)">
            <div>Niche: <span className="text-(--text-primary)">{listing.trend_brief?.niche ?? "—"}</span></div>
            <div className="font-mono">{listing.id.slice(0, 8)}</div>
            <div>{formatRelative(listing.updated_at)}</div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <header>
            <h3 className="font-display text-lg font-semibold text-(--text-primary)">
              {listing.title ?? <span className="text-(--text-faint)">(no title yet)</span>}
            </h3>
            <div className="mt-1 flex items-center gap-3 text-xs text-(--text-muted)">
              <span className="tabular text-(--accent-warm) font-semibold">
                {formatUsd(listing.price_usd)}
              </span>
              <span>·</span>
              <span>{(listing.tags?.length ?? 0)} tags</span>
            </div>
          </header>

          {listing.description && (
            <p className="line-clamp-5 text-sm text-(--text-secondary)">
              {listing.description}
            </p>
          )}

          {listing.tags && listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {listing.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-xs text-(--text-secondary)"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <ComplianceChecks
            title={listing.title}
            description={listing.description}
            tags={listing.tags}
            priceUsd={listing.price_usd}
            mockupsFromActualDesign={listing.design_packages?.mockups_from_actual_design ?? false}
          />

          <div className="mt-1 flex flex-wrap gap-2">
            <form action={approveListing}>
              <input type="hidden" name="id" value={listing.id} />
              <Button type="submit" variant="primary" size="sm">
                Approve & publish
              </Button>
            </form>
            <form action={regenerateCopy}>
              <input type="hidden" name="id" value={listing.id} />
              <Button type="submit" variant="secondary" size="sm">
                Regenerate copy
              </Button>
            </form>
            <details className="ml-auto">
              <summary className="cursor-pointer rounded-(--radius-sm) bg-(--surface-2) px-3 py-1.5 text-xs text-(--text-secondary) hover:text-(--text-primary)">
                Reject…
              </summary>
              <form action={rejectListing} className="mt-2 flex items-center gap-2">
                <input type="hidden" name="id" value={listing.id} />
                <input
                  name="reason"
                  placeholder="Reason (logged to error_message)"
                  className="h-8 w-64 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-xs text-(--text-primary)"
                />
                <Button type="submit" variant="danger" size="sm">
                  Reject
                </Button>
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
