"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { unarchiveBrief, archiveBrief } from "@/lib/actions/builder";
import { deleteBrief } from "@/lib/actions/scout";
import type { TrendBriefRow } from "@/lib/queries/types";

interface Props {
  brief: TrendBriefRow;
}

/**
 * Single row inside the Builder page's Archived section.
 *
 * Shows niche + age, with two actions:
 *   - Restore: flips 'archived' → 'needs_description' (back to active queue)
 *   - Delete: two-step destructive confirm via ConfirmDelete (blocked when designs reference it)
 */
export function ArchivedBriefRow({ brief }: Props) {
  const [isRestoring, startRestore] = useTransition();

  const created = new Date(brief.created_at).toISOString().slice(0, 10);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-(--text-primary)">
          {brief.niche}
        </span>
        <span className="font-mono text-[11px] text-(--text-muted)">
          {brief.id.slice(0, 8)} · {created}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Restore — puts the brief back in the active Builder queue */}
        <form
          action={(fd) => {
            startRestore(async () => {
              await unarchiveBrief(fd);
            });
          }}
        >
          <input type="hidden" name="id" value={brief.id} />
          <Button type="submit" variant="secondary" size="sm" disabled={isRestoring}>
            {isRestoring ? "Restoring…" : "Restore"}
          </Button>
        </form>

        {/* Delete — permanent; blocked when design_packages reference this brief */}
        <ConfirmDelete
          action={deleteBrief}
          id={brief.id}
          label="Delete"
          helper="This cannot be undone. Delete any linked designs first."
        />
      </div>
    </div>
  );
}
