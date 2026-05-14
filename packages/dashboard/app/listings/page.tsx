import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { ReviewCard } from "@/components/listings/ReviewCard";
import { ListingRow } from "@/components/listings/ListingRow";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { RealtimeRefresh } from "@/components/realtime/RealtimeRefresh";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  getNeedsReviewQueue,
  getRecentListings,
} from "@/lib/queries/listings";

export const revalidate = 30;

export default async function ListingsPage() {
  const [reviewQueue, recent] = await Promise.all([
    getNeedsReviewQueue(),
    getRecentListings(20),
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

      <SurfaceCard
        title={`Review queue — ${reviewQueue.length}`}
        subtitle="needs_review · waiting on you"
      >
        {reviewQueue.length === 0 ? (
          <EmptyState
            title="Inbox zero."
            hint="No listings are awaiting human review right now."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {reviewQueue.map((l) => (
              <ReviewCard key={l.id} listing={l} />
            ))}
          </div>
        )}
      </SurfaceCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard className="lg:col-span-2" title="Recent listings" subtitle="Last 20 (any status)">
          {recent.length === 0 ? (
            <EmptyState title="No listings yet" />
          ) : (
            <div className="flex flex-col gap-2">
              {recent.map((l) => (
                <ListingRow key={l.id} listing={l} />
              ))}
            </div>
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}
