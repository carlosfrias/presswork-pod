"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { StatusBadge } from "@/components/status/StatusBadge";
import { ColorPaletteEditor } from "@/components/design/ColorPaletteEditor";
import { formatRelative } from "@/lib/format";
import { approveDesign, deleteDesign, regenerateDesign } from "@/lib/actions/design";
import type { DesignReviewItem } from "@/lib/queries/design";

export function DesignReviewCard({ design: d }: { design: DesignReviewItem }) {
  // Mask toggle. Default to the masked (final) image; clicking flips to the
  // pre-mask preview so the operator can verify the fal.ai background-removal
  // mask cut cleanly. image_url_unmasked is NULL on designs created before
  // migration 026 — in that case the toggle is hidden and the click is a no-op.
  const [showMask, setShowMask] = useState(true);
  const hasUnmasked = !!d.image_url_unmasked;
  const activeImage =
    showMask || !hasUnmasked ? d.image_url : d.image_url_unmasked;

  // Editable prompt. Seeded with the original fal_prompt; on submit, the form
  // POSTs whatever's in the textarea to regenerateDesign, which writes it to
  // trend_briefs.custom_flux_prompt and the next Design run picks it up.
  const [editedPrompt, setEditedPrompt] = useState(d.fal_prompt ?? "");
  const promptDirty = editedPrompt.trim() !== (d.fal_prompt ?? "").trim();

  // Editable color palette. Seeded from the brief's persisted palette. On
  // regen submit, the form POSTs the new palette and regenerateDesign writes
  // it back to trend_briefs.color_palette before flipping status to approved.
  const initialPalette = d.trend_brief?.color_palette ?? [];
  const [palette, setPalette] = useState<string[]>(initialPalette);
  const paletteDirty =
    JSON.stringify(palette) !== JSON.stringify(initialPalette);

  return (
    <article className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => hasUnmasked && setShowMask((v) => !v)}
            disabled={!hasUnmasked}
            aria-label={
              !hasUnmasked
                ? "No pre-mask preview saved for this design"
                : showMask
                  ? "Show pre-mask preview"
                  : "Show masked image"
            }
            className="group relative aspect-square w-full overflow-hidden rounded-(--radius) border border-(--surface-line) bg-(--surface-2) disabled:cursor-default"
          >
            {activeImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeImage}
                alt={showMask ? "Masked design" : "Pre-mask preview"}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
                no image
              </div>
            )}
            {hasUnmasked && (
              <span className="absolute right-2 bottom-2 rounded-(--radius-sm) bg-(--surface-1)/85 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-(--text-secondary) group-hover:bg-(--surface-1)">
                {showMask ? "masked" : "pre-mask"} · click to flip
              </span>
            )}
          </button>
          <div className="text-xs text-(--text-muted)">
            <div>
              Niche:{" "}
              <span className="text-(--text-primary)">
                {d.trend_brief?.niche ?? "—"}
              </span>
            </div>
            <div className="font-mono">{d.id.slice(0, 8)}</div>
            <div>{formatRelative(d.created_at)}</div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <header className="flex items-start justify-between">
            <div>
              <h3 className="font-display text-lg font-semibold text-(--text-primary)">
                Awaiting review
              </h3>
              <p className="mt-1 text-xs text-(--text-muted)">
                Approve to release into the Listing queue. Edit the prompt
                below and Regen to rebuild from your edit.
              </p>
            </div>
            <StatusBadge status={d.status} />
          </header>

          {d.fal_prompt != null && (
            <details className="text-xs" open={promptDirty}>
              <summary className="cursor-pointer text-(--text-muted) hover:text-(--text-primary)">
                Prompt {promptDirty && <span className="text-(--accent-warm)">· edited</span>}
              </summary>
              <textarea
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={5}
                form={`regen-${d.id}`}
                name="custom_flux_prompt"
                className="mt-1.5 w-full rounded-(--radius-sm) bg-(--surface-2) p-2 font-mono text-[11px] leading-snug text-(--text-secondary) focus:bg-(--surface-3) focus:outline-none focus:ring-1 focus:ring-(--accent-warm)"
                aria-label="Edit prompt before regenerating"
              />
              {promptDirty && (
                <p className="mt-1 text-[10px] text-(--text-muted)">
                  Regen will use this edited prompt. Approve discards the edit.
                </p>
              )}
            </details>
          )}

          <details className="text-xs" open={paletteDirty}>
            <summary className="cursor-pointer text-(--text-muted) hover:text-(--text-primary)">
              Ink palette {paletteDirty && <span className="text-(--accent-warm)">· edited</span>}
            </summary>
            <div className="mt-1.5">
              <ColorPaletteEditor
                value={palette}
                onChange={setPalette}
                compact
              />
            </div>
            {paletteDirty && (
              <p className="mt-1 text-[10px] text-(--text-muted)">
                Regen will use this palette. Approve discards the edit.
              </p>
            )}
          </details>
          {/* The editor lives inside a <details> block, but its hidden input
              needs to ride along with the Regen submit. The editor's `name`
              prop emits the hidden input wherever it's mounted — but a hidden
              input inside a sibling form doesn't auto-attach. Mirror the
              current palette into a hidden input attached to the regen form
              instead. */}
          <input
            type="hidden"
            form={`regen-${d.id}`}
            name="color_palette"
            value={JSON.stringify(
              palette.filter((h) => /^#[0-9a-f]{6}$/.test(h.toLowerCase())),
            )}
          />

          {d.error_message && (
            <div className="rounded-(--radius-sm) bg-(--accent-bad)/10 p-2 text-xs text-(--accent-bad)">
              {d.error_message}
            </div>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {d.printify_blueprint_id != null && (
              <>
                <dt className="text-(--text-muted)">Blueprint</dt>
                <dd className="tabular text-(--text-secondary)">{d.printify_blueprint_id}</dd>
              </>
            )}
            {d.printify_print_provider_id != null && (
              <>
                <dt className="text-(--text-muted)">Print provider</dt>
                <dd className="tabular text-(--text-secondary)">{d.printify_print_provider_id}</dd>
              </>
            )}
            {d.printify_variant_ids && d.printify_variant_ids.length > 0 && (
              <>
                <dt className="text-(--text-muted)">Variants</dt>
                <dd className="text-(--text-secondary)">{d.printify_variant_ids.length}</dd>
              </>
            )}
            {d.mockup_urls && d.mockup_urls.length > 0 && (
              <>
                <dt className="text-(--text-muted)">Mockups</dt>
                <dd className="text-(--text-secondary)">{d.mockup_urls.length}</dd>
              </>
            )}
          </dl>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <form action={approveDesign}>
              <input type="hidden" name="id" value={d.id} />
              <Button type="submit" variant="success">
                Approve
              </Button>
            </form>
            {/* `id` on the form lets the textarea above attach via the
                `form` attribute, so the edited prompt rides along on submit
                even though the textarea sits inside the prompt <details>. */}
            <form action={regenerateDesign} id={`regen-${d.id}`}>
              <input type="hidden" name="id" value={d.id} />
              <Button type="submit" variant="secondary">
                {promptDirty || paletteDirty ? "Regen with edit" : "Regen"}
              </Button>
            </form>
            <div className="ml-auto w-44">
              <ConfirmDelete
                action={deleteDesign}
                id={d.id}
                helper="Removes the design row. Refused if a listing references it."
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
