import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { DesignGrid } from "@/components/design/DesignGrid";
import { DesignReviewCard } from "@/components/design/DesignReviewCard";
import { SpendPanel } from "@/components/design/SpendPanel";
import { InjectDesignForm } from "@/components/design/InjectDesignForm";
import { FlagsRail } from "@/components/flags/FlagsRail";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  getRecentDesigns,
  getDesignSpend,
  getDesignReviewQueue,
} from "@/lib/queries/design";

export const revalidate = 30;

export default async function DesignPage() {
  const [recent, spend, reviewQueue] = await Promise.all([
    getRecentDesigns(24),
    getDesignSpend(30),
    getDesignReviewQueue(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Design</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
            FLUX → upscaler → BiRefNet pipeline. Designs wait for your approval before Listing claims them.
          </p>
        </div>
        <AgentRunButton agent="design" />
      </header>

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
              <DesignReviewCard key={d.id} design={d} />
            ))}
          </div>
        )}
      </SurfaceCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard className="lg:col-span-2" title="Recent designs" subtitle="Last 24">
          <DesignGrid designs={recent} />
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
            keys={[
              "design_manual_mode_enabled",
              "upscaler_enabled",
              "background_removal_mode",
            ]}
            title="Design flags"
          />
        </div>
      </div>
    </div>
  );
}
