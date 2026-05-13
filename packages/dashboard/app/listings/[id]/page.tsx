import Link from "next/link";
import { notFound } from "next/navigation";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/status/StatusBadge";
import { MockupCarousel } from "@/components/listings/MockupCarousel";
import { ComplianceChecks } from "@/components/listings/ComplianceChecks";
import {
  approveListing,
  recreatePrintifyProduct,
  regenerateCopy,
  rejectListing,
  retryListing,
} from "@/lib/actions/listings";
import { getListing } from "@/lib/queries/listings";
import { formatRelative, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export default async function ListingDetailPage({ params }: Params) {
  const { id } = await params;
  const listing = await getListing(id);
  if (!listing) notFound();

  const etsyHref = listing.etsy_listing_id
    ? `https://www.etsy.com/listing/${listing.etsy_listing_id}`
    : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/listings"
            className="text-xs text-(--text-muted) hover:text-(--text-primary)"
          >
            ← Listings
          </Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-(--text-primary)">
            {listing.title ?? <span className="text-(--text-faint)">(no title)</span>}
          </h1>
          <p className="mt-1 text-xs text-(--text-muted) font-mono">
            {listing.id} · {formatRelative(listing.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={listing.status} />
          {etsyHref && (
            <a
              href={etsyHref}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-(--accent-warm) hover:underline"
            >
              View on Etsy →
            </a>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-6">
          <SurfaceCard title="Mockups" subtitle={`Design ${listing.design_packages?.id?.slice(0, 8) ?? "—"}`}>
            <MockupCarousel
              imageUrl={listing.design_packages?.image_url ?? null}
              mockupUrls={listing.design_packages?.mockup_urls ?? null}
              alt={listing.title ?? "Listing"}
            />
          </SurfaceCard>

          <SurfaceCard title="Copy">
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-xs text-(--text-muted)">Title ({listing.title?.length ?? 0}/140)</div>
                <p className="mt-1 text-base text-(--text-primary)">
                  {listing.title ?? "—"}
                </p>
              </div>
              <div>
                <div className="text-xs text-(--text-muted)">Description</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-(--text-secondary)">
                  {listing.description ?? "—"}
                </p>
              </div>
              <div>
                <div className="text-xs text-(--text-muted)">Tags ({listing.tags?.length ?? 0})</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {(listing.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-xs text-(--text-secondary)"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </SurfaceCard>

          {listing.error_message && (
            <SurfaceCard title="Last error">
              <pre className="overflow-x-auto rounded-(--radius-sm) bg-(--accent-bad)/10 p-3 text-xs text-(--accent-bad)">
                {listing.error_message}
              </pre>
            </SurfaceCard>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <SurfaceCard title="Facts">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-(--text-muted)">Price</dt>
              <dd className="tabular text-(--accent-warm)">{formatUsd(listing.price_usd)}</dd>
              <dt className="text-(--text-muted)">Niche</dt>
              <dd>{listing.trend_brief?.niche ?? "—"}</dd>
              <dt className="text-(--text-muted)">Printify</dt>
              <dd className="font-mono text-xs">{listing.printify_product_id ?? "—"}</dd>
              <dt className="text-(--text-muted)">Etsy listing</dt>
              <dd className="font-mono text-xs">{listing.etsy_listing_id ?? "—"}</dd>
              <dt className="text-(--text-muted)">Retries</dt>
              <dd className="tabular">{listing.retry_count}</dd>
            </dl>
          </SurfaceCard>

          <SurfaceCard title="Compliance">
            <ComplianceChecks
              title={listing.title}
              description={listing.description}
              tags={listing.tags}
              priceUsd={listing.price_usd}
              mockupsFromActualDesign={listing.design_packages?.mockups_from_actual_design ?? false}
            />
          </SurfaceCard>

          <SurfaceCard title="Actions">
            <div className="flex flex-col gap-2">
              {listing.status === "needs_review" && (
                <form action={approveListing}>
                  <input type="hidden" name="id" value={listing.id} />
                  <Button type="submit" variant="primary" className="w-full">
                    Approve & publish
                  </Button>
                </form>
              )}
              <form action={regenerateCopy}>
                <input type="hidden" name="id" value={listing.id} />
                <Button type="submit" variant="secondary" className="w-full">
                  Regenerate copy
                </Button>
              </form>
              <form action={recreatePrintifyProduct}>
                <input type="hidden" name="id" value={listing.id} />
                <Button type="submit" variant="secondary" className="w-full">
                  Recreate Printify product
                </Button>
              </form>
              {listing.status === "error" && (
                <form action={retryListing}>
                  <input type="hidden" name="id" value={listing.id} />
                  <Button type="submit" variant="ghost" className="w-full">
                    Retry from error
                  </Button>
                </form>
              )}
              <details className="rounded-(--radius-sm) border border-(--surface-line) p-2 text-xs">
                <summary className="cursor-pointer text-(--text-secondary)">Reject…</summary>
                <form action={rejectListing} className="mt-2 flex flex-col gap-2">
                  <input type="hidden" name="id" value={listing.id} />
                  <textarea
                    name="reason"
                    rows={2}
                    placeholder="Reason (logged to error_message)"
                    className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-2 text-xs"
                  />
                  <Button type="submit" variant="danger" size="sm">
                    Reject
                  </Button>
                </form>
              </details>
            </div>
          </SurfaceCard>
        </div>
      </div>
    </div>
  );
}
