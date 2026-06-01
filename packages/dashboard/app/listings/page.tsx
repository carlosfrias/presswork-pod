import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { CollapsibleErrorCard } from "@/components/listings/CollapsibleErrorCard";
import { ReviewCard } from "@/components/listings/ReviewCard";
import { ListingRow } from "@/components/listings/ListingRow";
import { ListingReviewRow } from "@/components/listings/ListingReviewRow";
import { ListingActionRow } from "@/components/listings/ListingActionRow";
import { runChecks } from "@/components/listings/ComplianceChecks";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { RealtimeRefresh } from "@/components/realtime/RealtimeRefresh";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  getAllListings,
  getActiveListings,
  getErrorListings,
  getNeedsReviewQueue,
  getPendingPublishListings,
} from "@/lib/queries/listings";
import type { ListingWithDesign } from "@/lib/queries/listings";

function complianceProps(l: ListingWithDesign) {
  const checks = runChecks({
    title: l.title,
    description: l.description,
    tags: l.tags,
    priceUsd: l.price_usd,
    mockupsFromActualDesign: l.design_packages?.mockups_from_actual_design ?? false,
  });
  const failing = checks.filter((c) => !c.pass);
  return {
    complianceFailCount: failing.length,
    complianceFailingLabels: failing.map((c) => c.label).join(", "),
  };
}

export const revalidate = 30;

export default async function ListingsPage() {
  const [reviewQueue, errors, pendingPublish, active, allListings] = await Promise.all([
    getNeedsReviewQueue(),
    getErrorListings(30),
    getPendingPublishListings(),
    getActiveListings(),
    getAllListings(500),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresh table="listings" channelName="listings-page-refresh" />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Listings</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
            Approve, regenerate, or reject. Approval flips status → pending_publish; the next
            listing run publishes to Etsy.
          </p>
        </div>
        <AgentRunButton agent="listing" />
      </header>

      {errors.length > 0 && (
        <SurfaceCard
          title={`Errors — ${errors.length}`}
          subtitle="Collapsed by default — click a row to expand. Clear removes the listing and optionally frees the design."
          className="border-(--accent-bad)/40"
        >
          <div className="flex flex-col gap-2">
            {errors.map((l) => (
              <CollapsibleErrorCard key={l.id} listing={l}>
                <ReviewCard listing={l} />
              </CollapsibleErrorCard>
            ))}
          </div>
        </SurfaceCard>
      )}

      <SurfaceCard
        title={`Review queue — ${reviewQueue.length}`}
        subtitle="needs_review · click Edit to edit copy inline, or ↗ to open the full detail page."
      >
        {reviewQueue.length === 0 ? (
          <EmptyState
            title="Inbox zero."
            hint="No listings are awaiting human review right now."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {reviewQueue.map((l) => (
              <ListingReviewRow key={l.id} listing={l} {...complianceProps(l)} />
            ))}
          </div>
        )}
      </SurfaceCard>

      {pendingPublish.length > 0 && (
        <SurfaceCard
          title={`Pending publish — ${pendingPublish.length}`}
          subtitle="Approved · queued for Etsy. Open a row to publish individually ($0.20/listing), or run the listing agent to publish all. Back up returns to review."
        >
          <div className="flex flex-col gap-2">
            {pendingPublish.map((l) => (
              <ListingActionRow key={l.id} listing={l} />
            ))}
          </div>
        </SurfaceCard>
      )}

      {active.length > 0 && (
        <SurfaceCard
          title={`Active — ${active.length}`}
          subtitle="Live on Etsy. Back up deactivates and returns to pending publish. Clear deactivates and deletes."
        >
          <div className="flex flex-col gap-2">
            {active.map((l) => (
              <ListingActionRow key={l.id} listing={l} />
            ))}
          </div>
        </SurfaceCard>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard
          className="lg:col-span-2"
          title={`All listings — ${allListings.length}`}
          subtitle="Full history (any status), newest first. Capped at 500."
        >
          {allListings.length === 0 ? (
            <EmptyState title="No listings yet" />
          ) : (
            <div className="flex flex-col gap-2">
              {allListings.map((l) => (
                <ListingRow key={l.id} listing={l} />
              ))}
            </div>
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}
