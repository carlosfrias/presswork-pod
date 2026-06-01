import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FromScoutCard } from "@/components/builder/FromScoutCard";
import { ManualEntryForm } from "@/components/builder/ManualEntryForm";
import { ArchivedBriefRow } from "@/components/builder/ArchivedBriefRow";
import { RealtimeRefresh } from "@/components/realtime/RealtimeRefresh";
import { getBuilderQueue, getArchivedBriefs } from "@/lib/queries/builder";
import { getRuntimeFlags } from "@/lib/queries/overview";
import { deriveDefaultImageModel } from "@/lib/models/image-models";

export const revalidate = 30;

export default async function BuilderPage() {
  const [queue, archived, flags] = await Promise.all([
    getBuilderQueue(),
    getArchivedBriefs(),
    getRuntimeFlags(),
  ]);
  const defaultImageModel = deriveDefaultImageModel(flags);

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresh table="trend_briefs" channelName="builder-page-refresh" />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Builder</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
            Type a free-form seed, click <strong>Build prompt</strong>, and Claude
            fleshes out a render-ready description using Scout&apos;s trend signals as
            priors. Anything you name in the seed is locked. Edit the result and
            send it to Design. <strong>Each Send spawns a child design</strong> —
            the brief stays in this queue so you can iterate and ship many
            variations from the same trend signal.
          </p>
        </div>
      </header>

      <SurfaceCard
        title={`From Scout — ${queue.length}`}
        subtitle="Approved on Scout. Each Send forks a new design — the brief stays here for more."
      >
        {queue.length === 0 ? (
          <EmptyState
            title="Inbox zero."
            hint="Approve briefs on the Scout page to populate this queue."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {queue.map((b) => (
              <FromScoutCard
                key={b.id}
                brief={b}
                defaultImageModel={defaultImageModel}
              />
            ))}
          </div>
        )}
      </SurfaceCard>

      <SurfaceCard
        title="Manual entry"
        subtitle="No upstream brief — you pick the niche and seed the prompt"
      >
        <ManualEntryForm defaultImageModel={defaultImageModel} />
      </SurfaceCard>

      <SurfaceCard
        title={`Archived — ${archived.length}`}
        subtitle="Parked briefs. Restore to return one to the active queue, or delete to remove it permanently."
      >
        {archived.length === 0 ? (
          <EmptyState
            title="Nothing archived."
            hint="Click Archive on any From Scout card to park it here."
          />
        ) : (
          <div className="flex flex-col divide-y divide-(--surface-line)">
            {archived.map((b) => (
              <ArchivedBriefRow key={b.id} brief={b} />
            ))}
          </div>
        )}
      </SurfaceCard>
    </div>
  );
}
