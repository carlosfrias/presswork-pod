import { StatusBadge } from "@/components/status/StatusBadge";
import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelative } from "@/lib/format";
import { deleteDesign, regenerateDesign, retryDesign } from "@/lib/actions/design";
import type { DesignPackageRow } from "@/lib/queries/types";

export function DesignGrid({ designs }: { designs: DesignPackageRow[] }) {
  if (designs.length === 0) {
    return <EmptyState title="No designs yet" hint="Design polls every 15 minutes." />;
  }
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {designs.map((d) => (
        <li
          key={d.id}
          className="group overflow-hidden rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-2)"
        >
          <div className="relative aspect-square w-full bg-(--surface-1)">
            {d.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={d.image_url}
                alt="Design"
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
                no image
              </div>
            )}
            {/* Only flag when mockups exist but the provenance bit wasn't flipped.
                Default-false on fresh designs is normal — Listing flips it when it
                creates the Printify product. */}
            {(d.mockup_urls?.length ?? 0) > 0 && !d.mockups_from_actual_design && (
              <span
                className="absolute top-2 right-2 rounded-(--radius-sm) bg-(--accent-bad)/80 px-1.5 py-0.5 text-[10px] font-medium text-(--surface-0)"
                title="Mockups exist but mockups_from_actual_design is false — compliance rule #4 violation"
              >
                provenance!
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between">
              <StatusBadge status={d.status} />
              <span className="text-xs text-(--text-muted) tabular">
                {formatRelative(d.created_at)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-(--text-muted)">
              <span className="font-mono">{d.id.slice(0, 6)}</span>
              {d.printify_blueprint_id && <span>· bp {d.printify_blueprint_id}</span>}
              {d.mockup_urls?.length ? <span>· {d.mockup_urls.length} mockups</span> : null}
            </div>
            {d.error_message && (
              <div className="line-clamp-2 rounded-(--radius-sm) bg-(--accent-bad)/10 p-2 text-xs text-(--accent-bad)">
                {d.error_message}
              </div>
            )}
            {d.fal_prompt && (
              <details className="text-xs">
                <summary className="cursor-pointer text-(--text-muted) hover:text-(--text-primary)">
                  Prompt
                </summary>
                <p className="mt-1.5 rounded-(--radius-sm) bg-(--surface-1) p-2 font-mono text-[11px] leading-snug text-(--text-secondary)">
                  {d.fal_prompt}
                </p>
              </details>
            )}
            <div className="flex gap-2">
              <form action={regenerateDesign} className="flex-1">
                <input type="hidden" name="id" value={d.id} />
                <Button type="submit" size="sm" variant="secondary" className="w-full">
                  Regenerate
                </Button>
              </form>
              {d.status === "error" && (
                <form action={retryDesign} className="flex-1">
                  <input type="hidden" name="id" value={d.id} />
                  <Button type="submit" size="sm" variant="ghost" className="w-full">
                    Retry
                  </Button>
                </form>
              )}
            </div>
            <ConfirmDelete
              action={deleteDesign}
              id={d.id}
              helper="Really?"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
