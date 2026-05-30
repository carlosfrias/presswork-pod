import Link from "next/link";
import { notFound } from "next/navigation";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/status/StatusBadge";
import { MockupCarousel } from "@/components/listings/MockupCarousel";
import { EtsyImagePanel } from "@/components/listings/EtsyImagePanel";
import { ComplianceChecks } from "@/components/listings/ComplianceChecks";
import { EtsyPayloadPreview } from "@/components/listings/EtsyPayloadPreview";
import { CopyEditor } from "@/components/listings/CopyEditor";
import { StaleArtworkBadge } from "@/components/listings/StaleArtworkBadge";
import { DynamicMockupsTrigger } from "@/components/listings/DynamicMockupsTrigger";
import { SubmitButton } from "@/components/ui/SubmitButton";
import {
  approveListing,
  publishListingNow,
  pushListingToEtsy,
  recreatePrintifyProduct,
  regenerateCopy,
  rejectListing,
  retryListing,
} from "@/lib/actions/listings";
import { getListing, type ListingWithDesign } from "@/lib/queries/listings";
import { getEtsyPayloadPreview } from "@/lib/queries/etsy-preview";
import { getIsListingAgentRunning } from "@/lib/actions/triggers";
import { formatRelative, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export default async function ListingDetailPage({ params }: Params) {
  const { id } = await params;
  const [listing, etsyPreview, isAgentRunning] = await Promise.all([
    getListing(id),
    getEtsyPayloadPreview(id),
    getIsListingAgentRunning(),
  ]);
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
          <SurfaceCard
            title="Mockups"
            subtitle={`Design ${listing.design_packages?.id?.slice(0, 8) ?? "—"}`}
          >
            <div className="flex flex-col gap-4">
              <StaleArtworkBadge listing={listing} variant="card" />
              <MockupCarousel
                imageUrl={listing.design_packages?.image_url ?? null}
                mockupUrls={listing.design_packages?.mockup_urls ?? null}
                alt={listing.title ?? "Listing"}
              />
              <DynamicMockupsTrigger
                listingId={listing.id}
                blueprintId={
                  listing.design_packages?.printify_blueprint_id ?? null
                }
              />
            </div>
          </SurfaceCard>

          {listing.status === "active" && listing.etsy_listing_id && (
            <EtsyImagePanel
              listingId={listing.id}
              etsyListingId={listing.etsy_listing_id}
              designImageUrl={listing.design_packages?.image_url ?? null}
              mockupUrls={listing.design_packages?.mockup_urls ?? null}
            />
          )}

          <SurfaceCard
            title="Copy"
            subtitle={
              listing.status === "needs_review"
                ? "Edit and save before approving. Same gates the publisher runs apply here."
                : listing.status === "active"
                  ? "Edit live-listing copy. Save stages changes; Push to Etsy applies them to the live listing."
                  : listing.status === "error"
                    ? "Fix the copy/price below, Save, then click Retry from error in the Actions card."
                    : `Read-only — copy can only be edited at status='needs_review', 'active', or 'error' (current: ${listing.status})`
            }
          >
            {listing.status === "needs_review" ? (
              <CopyEditor
                listingId={listing.id}
                initialTitle={listing.title}
                initialDescription={listing.description}
                initialTags={listing.tags}
                initialPriceUsd={listing.price_usd}
              />
            ) : listing.status === "active" ? (
              <div className="flex flex-col gap-4">
                <CopyEditor
                  listingId={listing.id}
                  initialTitle={listing.title}
                  initialDescription={listing.description}
                  initialTags={listing.tags}
                  initialPriceUsd={listing.price_usd}
                  mode="active"
                />
                <PushToEtsyForm listing={listing} />
              </div>
            ) : listing.status === "error" ? (
              <CopyEditor
                listingId={listing.id}
                initialTitle={listing.title}
                initialDescription={listing.description}
                initialTags={listing.tags}
                initialPriceUsd={listing.price_usd}
                mode="error"
              />
            ) : (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-xs text-(--text-muted)">
                    Title ({listing.title?.length ?? 0}/140)
                  </div>
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
                  <div className="text-xs text-(--text-muted)">
                    Tags ({listing.tags?.length ?? 0})
                  </div>
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
            )}
          </SurfaceCard>

          {listing.error_message && (
            <SurfaceCard
              title="Last error"
              subtitle={`status='${listing.status}' · retry_count=${listing.retry_count}`}
            >
              <p className="whitespace-pre-wrap break-words rounded-(--radius-sm) border border-(--accent-bad)/30 bg-(--accent-bad)/10 p-4 text-sm leading-relaxed text-(--accent-bad)">
                {listing.error_message}
              </p>
            </SurfaceCard>
          )}

          <SurfaceCard
            title="Etsy payload preview"
            subtitle="What would be sent to Etsy on approve"
          >
            <EtsyPayloadPreview preview={etsyPreview} />
          </SurfaceCard>
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
                    Approve
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
                  <label className="flex items-center gap-2 text-xs text-(--text-muted)">
                    <input type="checkbox" name="send_design_back" />
                    <span>
                      Design issue — also flip design back to needs_review and free it for re-listing
                    </span>
                  </label>
                  <Button type="submit" variant="danger" size="sm">
                    Reject
                  </Button>
                </form>
              </details>
            </div>
          </SurfaceCard>

          {listing.status === "pending_publish" && (
            <PublishNowCard
              listingId={listing.id}
              isAgentRunning={isAgentRunning}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Two-step push UX for active listings: Save (handled by CopyEditor) writes
 * to the listings row only; this form is the second step that PATCHes the
 * change to Etsy. Disabled when there are no unpushed changes (updated_at <=
 * last_pushed_at) so the operator doesn't accidentally re-push the same
 * payload. last_pushed_at is set by pushListingToEtsy on success.
 */
function PushToEtsyForm({ listing }: { listing: ListingWithDesign }) {
  const lastPushed = listing.last_pushed_at
    ? new Date(listing.last_pushed_at)
    : null;
  const updated = new Date(listing.updated_at);
  // Round both to the second to avoid sub-millisecond timestamp jitter making
  // the button look perpetually dirty when last_pushed_at was set in the same
  // request that updated_at fired.
  const hasUnpushed = !lastPushed || updated.getTime() - lastPushed.getTime() > 1000;

  return (
    <form
      action={pushListingToEtsy}
      className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) p-3"
    >
      <input type="hidden" name="id" value={listing.id} />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-(--text-primary)">
            Push to Etsy
          </p>
          <p className="text-xs text-(--text-muted)">
            {hasUnpushed
              ? "Unpushed local edits — click to PATCH the live Etsy listing."
              : "All changes pushed."}
            {lastPushed && (
              <>
                {" · "}
                Last pushed {formatRelative(listing.last_pushed_at!)}
              </>
            )}
          </p>
        </div>
        <SubmitButton
          variant="primary"
          size="sm"
          idleLabel={hasUnpushed ? "Push to Etsy" : "Up to date"}
          pendingLabel="Pushing…"
          disabled={!hasUnpushed}
        />
      </div>
    </form>
  );
}

/**
 * Confirmation card for per-listing publish. Shown only when status is
 * 'pending_publish'. Uses the <details> popover pattern from the Reject card
 * so no JS is required and the operator sees the cost warning before clicking.
 *
 * Disabled when the listing agent is already actively publishing (isAgentRunning),
 * matching the Run Listing button lock so both the agent and this button can't
 * race against the same row at the same time.
 */
function PublishNowCard({
  listingId,
  isAgentRunning,
}: {
  listingId: string;
  isAgentRunning: boolean;
}) {
  return (
    <SurfaceCard
      title="Publish to Etsy"
      subtitle={
        isAgentRunning
          ? "The listing agent is currently publishing — wait for it to finish before publishing individually."
          : "Publish this listing now. Each publish charges the $0.20 Etsy listing fee."
      }
    >
      {isAgentRunning ? (
        <p className="text-xs text-(--text-muted)">
          Locked while the listing agent is running.
        </p>
      ) : (
        <details className="rounded-(--radius-sm) border border-(--surface-line) p-2 text-xs">
          <summary className="cursor-pointer text-(--text-secondary)">
            Publish now…
          </summary>
          <form
            action={publishListingNow}
            className="mt-2 flex flex-col gap-2"
          >
            <input type="hidden" name="id" value={listingId} />
            <p className="text-xs text-(--text-muted)">
              This will POST a new Etsy listing draft, upload mockup images, and
              activate the listing. Etsy charges a{" "}
              <strong className="text-(--text-primary)">$0.20 listing fee</strong>{" "}
              per listing.
            </p>
            <SubmitButton
              variant="primary"
              size="sm"
              idleLabel="Publish to Etsy ($0.20 listing fee)"
              pendingLabel="Publishing…"
            />
          </form>
        </details>
      )}
    </SurfaceCard>
  );
}
