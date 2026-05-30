"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Lightbox, ZoomButton } from "@/components/ui/Lightbox";
import { ReplaceImageForm } from "@/components/design/ReplaceImageForm";
import { formatRelative } from "@/lib/format";
import { withCacheBuster, withDownload, withTransform } from "@/lib/imageUrl";
import { cancelTouchUp, regenerateDesign } from "@/lib/actions/design";
import type { DesignReviewItem } from "@/lib/queries/design";

type StackEntry = {
  masked_url: string | null;
  unmasked_url: string | null;
  caption: string | null;
  index: number | null; // null for the synthetic fallback
};

function buildStack(d: DesignReviewItem): StackEntry[] {
  if (d.regen_stack.length > 0) {
    return d.regen_stack.map((v, i) => ({
      masked_url: v.masked_url,
      unmasked_url: v.unmasked_url,
      caption: [v.image_model, v.bg_removal_mode].filter(Boolean).join(" · ") || null,
      index: i,
    }));
  }
  return [
    {
      masked_url: d.image_url,
      unmasked_url: d.image_url_unmasked,
      caption: null,
      index: null,
    },
  ];
}

/**
 * Card for designs in 'touch_up' status. Includes the full version stack so
 * the operator can browse through prior iterations to choose the best base
 * for their edit before downloading.
 *
 * Uploading a replacement sends the design back to needs_review.
 * "Cancel" returns it to needs_review without any changes.
 */
export function TouchUpCard({ design: d }: { design: DesignReviewItem }) {
  const stack = useMemo(() => buildStack(d), [d]);
  const [stackIndex, setStackIndex] = useState(stack.length - 1);
  const safeIndex = Math.min(Math.max(stackIndex, 0), stack.length - 1);
  const active = stack[safeIndex];
  const hasStack = stack.length > 1;

  const [showMask, setShowMask] = useState(true);
  const [editedPrompt, setEditedPrompt] = useState(d.fal_prompt ?? "");
  const hasUnmasked = !!active.unmasked_url;
  const activeUrl = (showMask || !hasUnmasked ? active.masked_url : active.unmasked_url) ?? null;

  const [zoomOpen, setZoomOpen] = useState(false);
  const fullSrc = withCacheBuster(activeUrl, d.updated_at);
  const thumbSrc = withCacheBuster(
    withTransform(activeUrl, { width: 560, height: 560, quality: 85, resize: "cover" }),
    d.updated_at,
  );

  function step(delta: number) {
    setStackIndex((i) => {
      const next = Math.min(Math.max(i + delta, 0), stack.length - 1);
      if (next !== i) setShowMask(true);
      return next;
    });
  }

  return (
    <article className="rounded-(--radius-lg) border border-(--accent-warm)/30 bg-(--accent-warm)/5 p-5">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-3">
          {/* Image viewer with stack navigation */}
          <div
            className="group relative aspect-square w-full overflow-hidden rounded-(--radius) border border-(--surface-line) bg-(--surface-2)"
            tabIndex={hasStack ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
              else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
            }}
          >
            {fullSrc ? (
              <>
                <button
                  type="button"
                  onClick={() => hasUnmasked && setShowMask((v) => !v)}
                  disabled={!hasUnmasked}
                  className="block h-full w-full overflow-hidden disabled:cursor-default"
                  aria-label={showMask ? "Show pre-mask preview" : "Show masked image"}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbSrc ?? fullSrc}
                    alt={showMask ? "Masked design" : "Pre-mask preview"}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>

                {hasStack && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); step(-1); }}
                      disabled={safeIndex === 0}
                      aria-label="Previous version"
                      title="Previous version (←)"
                      className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-(--surface-0)/80 p-1.5 text-(--text-primary) shadow-md backdrop-blur-sm transition hover:bg-(--surface-0) disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronLeft />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); step(1); }}
                      disabled={safeIndex === stack.length - 1}
                      aria-label="Next version"
                      title="Next version (→)"
                      className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-(--surface-0)/80 p-1.5 text-(--text-primary) shadow-md backdrop-blur-sm transition hover:bg-(--surface-0) disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronRight />
                    </button>
                    <span className="pointer-events-none absolute left-2 top-2 rounded-(--radius-sm) bg-(--surface-1)/85 px-2 py-0.5 text-[10px] font-medium text-(--text-secondary)">
                      {safeIndex + 1} / {stack.length}
                    </span>
                  </>
                )}

                {hasUnmasked && (
                  <span className="pointer-events-none absolute right-2 bottom-2 rounded-(--radius-sm) bg-(--surface-1)/85 px-2 py-0.5 text-[10px] text-(--text-secondary)">
                    {showMask ? "masked" : "unmasked"} · click to flip
                  </span>
                )}

                <ZoomButton
                  onClick={() => setZoomOpen(true)}
                  ariaLabel="Zoom into design"
                  className="absolute top-2 right-2"
                />
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
                no image
              </div>
            )}
          </div>

          {fullSrc && (
            <Lightbox
              open={zoomOpen}
              onClose={() => setZoomOpen(false)}
              src={fullSrc}
              alt={showMask ? "Masked design" : "Pre-mask preview"}
              caption={
                hasStack
                  ? `v${safeIndex + 1}/${stack.length} · ${d.id.slice(0, 8)}`
                  : d.id.slice(0, 8)
              }
            />
          )}

          {active.caption && (
            <p className="text-[11px] text-(--text-muted)">{active.caption}</p>
          )}

          <div className="text-xs text-(--text-muted)">
            <div>
              Niche:{" "}
              <span className="text-(--text-primary)">{d.trend_brief?.niche ?? "—"}</span>
            </div>
            <div className="font-mono">{d.id.slice(0, 8)}</div>
            <div suppressHydrationWarning>{formatRelative(d.created_at)}</div>
            {d.generation_cost_usd > 0 && (
              <div className="mt-1 font-medium tabular text-(--text-secondary)">
                ${d.generation_cost_usd.toFixed(3)} total
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <header>
            <h3 className="font-display text-lg font-semibold text-(--text-primary)">
              Touch-up needed
            </h3>
            <p className="mt-1 text-xs text-(--text-muted)">
              Browse versions with ← →, pick the best base, then download and edit.
              Re-uploading returns the design to the review queue for a final approve pass.
            </p>
          </header>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-(--text-secondary)">1 · Download selected version</p>
            <div className="flex flex-wrap gap-2">
              {active.masked_url && (
                <a
                  href={withDownload(active.masked_url, `design-${d.id.slice(0, 8)}-v${safeIndex + 1}-masked.png`) ?? active.masked_url}
                  download={`design-${d.id.slice(0, 8)}-v${safeIndex + 1}-masked.png`}
                  className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                >
                  Download masked PNG
                </a>
              )}
              {active.unmasked_url && (
                <a
                  href={withDownload(active.unmasked_url, `design-${d.id.slice(0, 8)}-v${safeIndex + 1}-unmasked.png`) ?? active.unmasked_url}
                  download={`design-${d.id.slice(0, 8)}-v${safeIndex + 1}-unmasked.png`}
                  className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                >
                  Download unmasked PNG
                </a>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-(--text-secondary)">2 · Re-upload edited PNG</p>
            <div className="max-w-xs">
              <ReplaceImageForm id={d.id} />
            </div>
          </div>

          {d.fal_prompt != null && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-(--text-secondary)">3 · Or re-generate with edited prompt</p>
              <form action={regenerateDesign} className="flex flex-col gap-2">
                <input type="hidden" name="id" value={d.id} />
                <textarea
                  name="image_description"
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  rows={5}
                  className="w-full rounded-(--radius-sm) bg-(--surface-2) p-2 font-mono text-[11px] leading-snug text-(--text-secondary) focus:bg-(--surface-3) focus:outline-none focus:ring-1 focus:ring-(--accent-warm)"
                  aria-label="Edit prompt before regenerating"
                />
                <p className="text-[10px] text-(--text-muted)">
                  Submitting re-queues the design — it will return to the review queue once generation completes.
                </p>
                <div>
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    disabled={!editedPrompt.trim()}
                  >
                    Regen with edited prompt
                  </Button>
                </div>
              </form>
            </div>
          )}

          <div className="border-t border-(--surface-line) pt-3">
            <form action={cancelTouchUp}>
              <input type="hidden" name="id" value={d.id} />
              <Button type="submit" variant="ghost" size="sm">
                Cancel — back to review
              </Button>
            </form>
          </div>
        </div>
      </div>
    </article>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
