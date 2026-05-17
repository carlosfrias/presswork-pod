import { Suspense } from "react";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { NicheTable } from "@/components/scout/NicheTable";
import { BriefList } from "@/components/scout/BriefList";
import { BriefReviewCard } from "@/components/scout/BriefReviewCard";
import { InjectBriefForm } from "@/components/scout/InjectBriefForm";
import { FlagsRail } from "@/components/flags/FlagsRail";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  getAllBriefs,
  getNichePerformance,
  getBriefReviewQueue,
} from "@/lib/queries/scout";

export const revalidate = 30;

async function NichePerformancePanel() {
  const niches = await getNichePerformance(20);
  return <NicheTable rows={niches} />;
}

export default async function ScoutPage() {
  // NicheTable is the heaviest query (500-brief join). Stream it via
  // Suspense so the review queue and recent briefs paint first.
  const [allBriefs, reviewQueue] = await Promise.all([
    getAllBriefs(500),
    getBriefReviewQueue(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Scout</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
              Briefs wait for your approval before Design picks them up.
          </p>
        </div>
        <AgentRunButton agent="scout" />
      </header>

      <SurfaceCard
        title={`Review queue — ${reviewQueue.length}`}
        subtitle="needs_review · approve to release into the Design queue"
      >
        {reviewQueue.length === 0 ? (
          <EmptyState
            title="Inbox zero."
            hint="No briefs waiting. Run Scout to generate more."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {reviewQueue.map((b) => (
              <BriefReviewCard key={b.id} brief={b} />
            ))}
          </div>
        )}
      </SurfaceCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard className="lg:col-span-2" title="Niche performance" subtitle="Briefs → designs → listings → revenue, last 500 briefs">
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <NichePerformancePanel />
          </Suspense>
        </SurfaceCard>
        <div className="flex flex-col gap-6">
          <FlagsRail
            keys={["scout_vision_enabled"]}
            title="Scout flags"
          />
          <SurfaceCard title="Inject brief" subtitle="Manual trend; lands in the review queue">
            <InjectBriefForm />
          </SurfaceCard>
        </div>
      </div>

      <SurfaceCard
        title={`All briefs — ${allBriefs.length}`}
        subtitle="Full history, newest first. Capped at 500 — pagination lands once we routinely exceed that."
      >
        <BriefList briefs={allBriefs} />
      </SurfaceCard>
    </div>
  );
}
