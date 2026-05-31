import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { DesignGrid } from "@/components/design/DesignGrid";
import { DesignReviewCard } from "@/components/design/DesignReviewCard";
import { TouchUpCard } from "@/components/design/TouchUpCard";
import { RealtimeRefresh } from "@/components/realtime/RealtimeRefresh";
import { SpendPanel } from "@/components/design/SpendPanel";
import { InjectDesignForm } from "@/components/design/InjectDesignForm";
import { FlagsRail } from "@/components/flags/FlagsRail";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  getAllDesigns,
  getDesignSpend,
  getDesignReviewQueue,
  getTouchUpQueue,
} from "@/lib/queries/design";
import { getVariantOptions } from "@/lib/queries/variants";

export const revalidate = 30;

export default async function DesignPage() {
  const [allDesigns, spend, reviewQueue, touchUpQueue, variantOptions] =
    await Promise.all([
      getAllDesigns(500),
      getDesignSpend(30),
      getDesignReviewQueue(),
      getTouchUpQueue(),
      getVariantOptions(145, 39),
    ]);

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresh table="design_packages" channelName="design-page-refresh" />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Design</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
            FLUX → upscaler → BiRefNet pipeline. Designs wait for your approval before Listing claims them.
          </p>
        </div>
        <AgentRunButton agent="design" />
      </header>

      {touchUpQueue.length > 0 && (
        <SurfaceCard
          title={`Touch-up — ${touchUpQueue.length}`}
          subtitle="Download, edit locally, re-upload — returns to review queue for final approve"
        >
          <div className="flex flex-col gap-4">
            {touchUpQueue.map((d) => (
              <TouchUpCard key={d.id} design={d} />
            ))}
          </div>
        </SurfaceCard>
      )}

      <SurfaceCard
        id="review-queue"
        title={`Review queue — ${reviewQueue.length}`}
        subtitle="needs_review · approve to release into the Listing queue"
      >
        {reviewQueue.length === 0 ? (
          <EmptyState
            title="Inbox zero."
            hint="No designs waiting. Approve a brief on the Scout page, then run Design."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {reviewQueue.map((d) => (
              <DesignReviewCard key={d.id} design={d} variantOptions={variantOptions} />
            ))}
          </div>
        )}
      </SurfaceCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard
          className="lg:col-span-2"
          title={`All designs — ${allDesigns.length}`}
          subtitle="Full history, newest first. Capped at 500 — pagination lands once we routinely exceed that."
        >
          <DesignGrid designs={allDesigns} />
        </SurfaceCard>
        <div className="flex flex-col gap-6">
          <SurfaceCard title="fal.ai spend" subtitle="Last 30 days">
            <SpendPanel spend={spend} />
          </SurfaceCard>
          <SurfaceCard
            title="Inject design"
            subtitle="Write a prompt yourself · skips Claude prompt-builder"
          >
            <InjectDesignForm />
          </SurfaceCard>
          <FlagsRail
            keys={["upscaler_enabled"]}
            title="Design flags"
          />
        </div>
      </div>
    </div>
  );
}
