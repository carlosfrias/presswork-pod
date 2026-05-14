"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { Lightbox, ZoomButton } from "@/components/ui/Lightbox";
import { StatusBadge } from "@/components/status/StatusBadge";
import { ColorPaletteEditor } from "@/components/design/ColorPaletteEditor";
import { StylePicker } from "@/components/styles/StylePicker";
import { ImageModelPicker } from "@/components/models/ImageModelPicker";
import { BgRemovalPicker } from "@/components/models/BgRemovalPicker";
import { formatRelative } from "@/lib/format";
import { withCacheBuster } from "@/lib/imageUrl";
import {
  approveDesign,
  deleteDesign,
  regenerateDesign,
  remaskDesign,
} from "@/lib/actions/design";
import { cn } from "@/lib/cn";
import {
  applyStyleToPrompt,
  detectStyleInPrompt,
  type StyleId,
} from "@/lib/styles/catalog";
import type { ImageModelId } from "@/lib/models/image-models";
import type { BgRemovalModeId } from "@/lib/models/bg-removal";
import type { DesignReviewItem } from "@/lib/queries/design";

type StackEntry = {
  masked_url: string | null;
  unmasked_url: string | null;
  caption: string | null;
  // True for the synthetic entry we surface when regen_stack is empty —
  // distinguishes "no real history" from "browsing entry #0 of 1".
  synthetic: boolean;
  // Index in the original regen_stack array (or null for synthetic). Submitted
  // as `version_index` on approve/remask so the server snaps the row's
  // image_url{,_unmasked} to this entry before acting.
  serverIndex: number | null;
  meta: {
    prompt: string | null;
    image_model: string | null;
    image_quality: string | null;
    bg_removal_mode: string | null;
    created_at: string | null;
    backfilled?: boolean;
    remasked_at?: string;
  };
};

function buildStack(d: DesignReviewItem): StackEntry[] {
  if (d.regen_stack.length > 0) {
    return d.regen_stack.map((v, i) => ({
      masked_url: v.masked_url,
      unmasked_url: v.unmasked_url,
      caption: shortCaption(v),
      synthetic: false,
      serverIndex: i,
      meta: {
        prompt: v.prompt,
        image_model: v.image_model,
        image_quality: v.image_quality,
        bg_removal_mode: v.bg_removal_mode,
        created_at: v.created_at,
        backfilled: v.backfilled,
        remasked_at: v.remasked_at,
      },
    }));
  }
  // Legacy / pre-stack design: synthesize a single entry from the row's
  // current pointer so the viewer has something to render. Submitting no
  // version_index falls through to "approve/remask the row as-is".
  return [
    {
      masked_url: d.image_url,
      unmasked_url: d.image_url_unmasked,
      caption: null,
      synthetic: true,
      serverIndex: null,
      meta: {
        prompt: d.fal_prompt,
        image_model: d.trend_brief?.image_model ?? null,
        image_quality: null,
        bg_removal_mode: d.trend_brief?.background_removal_mode ?? null,
        created_at: d.created_at,
      },
    },
  ];
}

function shortCaption(v: DesignReviewItem["regen_stack"][number]): string {
  const parts: string[] = [];
  if (v.image_model) parts.push(v.image_model.replace(/^fal_/, ""));
  if (v.image_quality) parts.push(v.image_quality);
  if (v.bg_removal_mode) parts.push(`bg:${v.bg_removal_mode}`);
  if (v.backfilled) parts.push("backfilled");
  if (v.remasked_at) parts.push("re-masked");
  return parts.join(" · ");
}

export function DesignReviewCard({ design: d }: { design: DesignReviewItem }) {
  // Stack of historical iterations (newest-last). For legacy rows the stack
  // is a single synthetic entry pointing at the row's current image pair.
  const stack = useMemo(() => buildStack(d), [d]);
  // Newest-first browsing: default cursor = last entry. Re-derive whenever
  // the underlying design changes (new regen lands → jump to newest).
  const [stackIndex, setStackIndex] = useState(stack.length - 1);
  useEffect(() => {
    setStackIndex(stack.length - 1);
  }, [stack.length, d.id]);

  const safeIndex = Math.min(Math.max(stackIndex, 0), stack.length - 1);
  const active = stack[safeIndex];
  const hasStack = stack.length > 1;

  // Mask toggle. Defaults to masked (the operator's published-ready view);
  // clicking flips to the unmasked source for QA. Disabled when the active
  // stack entry has no unmasked saved (legacy entries pre-migration 026).
  const [showMask, setShowMask] = useState(true);
  const hasUnmasked = !!active.unmasked_url;
  const maskedSrc = withCacheBuster(active.masked_url, d.updated_at);
  const unmaskedSrc = withCacheBuster(active.unmasked_url, d.updated_at);
  const activeImage = showMask || !hasUnmasked ? maskedSrc : unmaskedSrc;

  const [zoomOpen, setZoomOpen] = useState(false);

  const [editedPrompt, setEditedPrompt] = useState(d.fal_prompt ?? "");
  const promptDirty = editedPrompt.trim() !== (d.fal_prompt ?? "").trim();

  const [style, setStyle] = useState<StyleId | null>(
    () => d.trend_brief?.style ?? detectStyleInPrompt(d.fal_prompt ?? ""),
  );

  const [imageModel, setImageModel] = useState<ImageModelId>(
    () => d.trend_brief?.image_model ?? "fal_gpt_image_2",
  );

  const [bgRemoval, setBgRemoval] = useState<BgRemovalModeId | null>(
    () => d.trend_brief?.background_removal_mode ?? null,
  );

  function handleStyleChange(next: StyleId | null) {
    setStyle(next);
    setEditedPrompt((current) => applyStyleToPrompt(current, next));
  }

  const [isApproving, startApprove] = useTransition();
  const [isRegenerating, startRegen] = useTransition();
  const [isRemasking, startRemask] = useTransition();
  const isBusy = isApproving || isRegenerating || isRemasking;

  function handleApprove(formData: FormData) {
    startApprove(async () => {
      await approveDesign(formData);
    });
  }

  function handleRegen(formData: FormData) {
    startRegen(async () => {
      await regenerateDesign(formData);
    });
  }

  function handleRemask(formData: FormData) {
    startRemask(async () => {
      await remaskDesign(formData);
    });
  }

  function step(delta: number) {
    if (isBusy) return;
    setStackIndex((i) => {
      const next = Math.min(Math.max(i + delta, 0), stack.length - 1);
      // Reset mask toggle when stepping so the operator always sees the
      // masked side of the new entry first — matches the default landing
      // experience for any entry.
      if (next !== i) setShowMask(true);
      return next;
    });
  }

  const initialPalette = d.trend_brief?.color_palette ?? [];
  const [palette, setPalette] = useState<string[]>(initialPalette);
  const paletteDirty =
    JSON.stringify(palette) !== JSON.stringify(initialPalette);

  // Browsing a non-newest entry should be visible — banner sits beneath the
  // image so the operator knows the action buttons (Approve / Re-mask) will
  // operate on this historical version, not the current pointer.
  const browsingHistory = hasStack && safeIndex !== stack.length - 1;

  // Hidden version_index value submitted with approve/remask. Synthetic
  // entries serialize as empty string → server falls back to "use current
  // row pointer". Real entries pass their stack index.
  const versionIndexValue =
    active.serverIndex !== null ? String(active.serverIndex) : "";

  return (
    <article className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-3">
          <div
            className={cn(
              "group relative aspect-square w-full transition-opacity",
              isBusy && "pointer-events-none opacity-60",
            )}
            aria-busy={isBusy || undefined}
            tabIndex={hasStack ? 0 : -1}
            onKeyDown={(e) => {
              if (!hasStack) return;
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                step(-1);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                step(1);
              }
            }}
          >
            <button
              type="button"
              onClick={() => hasUnmasked && setShowMask((v) => !v)}
              disabled={!hasUnmasked || isBusy}
              aria-label={
                !hasUnmasked
                  ? "No pre-mask preview saved for this version"
                  : showMask
                    ? "Show pre-mask preview"
                    : "Show masked image"
              }
              className="block h-full w-full overflow-hidden rounded-(--radius) border border-(--surface-line) bg-(--surface-2) disabled:cursor-default"
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
            </button>

            {hasStack && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(-1);
                  }}
                  disabled={safeIndex === 0 || isBusy}
                  aria-label="Previous version"
                  title="Previous version (←)"
                  className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-(--surface-0)/80 p-1.5 text-(--text-primary) shadow-md backdrop-blur-sm transition hover:bg-(--surface-0) disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(1);
                  }}
                  disabled={safeIndex === stack.length - 1 || isBusy}
                  aria-label="Next version"
                  title="Next version (→)"
                  className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full bg-(--surface-0)/80 p-1.5 text-(--text-primary) shadow-md backdrop-blur-sm transition hover:bg-(--surface-0) disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight />
                </button>
                <span className="pointer-events-none absolute left-2 top-2 rounded-(--radius-sm) bg-(--surface-1)/85 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-(--text-secondary)">
                  {safeIndex + 1} / {stack.length}
                </span>
              </>
            )}

            {hasUnmasked && (
              <span className="pointer-events-none absolute right-2 bottom-2 rounded-(--radius-sm) bg-(--surface-1)/85 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-(--text-secondary) group-hover:bg-(--surface-1)">
                {showMask ? "masked" : "unmasked"} · click to flip
              </span>
            )}
            {activeImage && !isBusy && (
              <ZoomButton
                onClick={() => setZoomOpen(true)}
                ariaLabel="Zoom into design"
                className="absolute top-2 right-2"
              />
            )}
            {isBusy && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex items-center gap-2 rounded-(--radius-md) bg-(--surface-0)/90 px-3 py-1.5 text-xs font-medium text-(--text-primary) shadow-lg backdrop-blur-sm">
                  <Spinner />
                  {isRegenerating
                    ? "Regenerating…"
                    : isRemasking
                      ? "Re-masking…"
                      : "Approving…"}
                </span>
              </div>
            )}
          </div>

          {browsingHistory && (
            <div className="rounded-(--radius-sm) border border-(--accent-warm)/40 bg-(--accent-warm)/10 px-2 py-1.5 text-[11px] leading-snug text-(--text-secondary)">
              <strong className="font-semibold text-(--text-primary)">
                Viewing version {safeIndex + 1} of {stack.length}.
              </strong>{" "}
              Approve / Re-mask will use this version, not the latest.
            </div>
          )}

          {activeImage && (
            <Lightbox
              open={zoomOpen}
              onClose={() => setZoomOpen(false)}
              src={activeImage}
              alt={showMask ? "Masked design" : "Pre-mask preview"}
              caption={
                hasStack
                  ? `v${safeIndex + 1}/${stack.length} · ${showMask ? "masked" : "unmasked"} · ${d.id.slice(0, 8)}`
                  : hasUnmasked
                    ? `${showMask ? "masked" : "unmasked"} · ${d.id.slice(0, 8)}`
                    : d.id.slice(0, 8)
              }
            />
          )}

          {(active.caption || active.meta.created_at) && (
            <div className="text-[11px] leading-snug text-(--text-muted)">
              {active.caption && (
                <div className="text-(--text-secondary)">{active.caption}</div>
              )}
              {active.meta.created_at && (
                <div className="tabular">
                  {formatRelative(active.meta.created_at)}
                </div>
              )}
            </div>
          )}

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
            <StylePicker value={style} onChange={handleStyleChange} />
          )}

          <ImageModelPicker
            value={imageModel}
            onChange={(next) => next && setImageModel(next)}
            label="Image model (regen target)"
          />

          <BgRemovalPicker value={bgRemoval} onChange={setBgRemoval} />

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
                name="image_description"
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
          <input
            type="hidden"
            form={`regen-${d.id}`}
            name="style"
            value={style ?? ""}
          />
          <input
            type="hidden"
            form={`regen-${d.id}`}
            name="image_model"
            value={imageModel}
          />
          <input
            type="hidden"
            form={`regen-${d.id}`}
            name="background_removal_mode"
            value={bgRemoval ?? ""}
          />
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
            <form action={handleApprove}>
              <input type="hidden" name="id" value={d.id} />
              <input type="hidden" name="version_index" value={versionIndexValue} />
              <Button type="submit" variant="success" disabled={isBusy}>
                {isApproving ? (
                  <>
                    <Spinner />
                    Approving…
                  </>
                ) : (
                  "Approve"
                )}
              </Button>
            </form>
            <form action={handleRegen} id={`regen-${d.id}`}>
              <input type="hidden" name="id" value={d.id} />
              <Button type="submit" variant="secondary" disabled={isBusy}>
                {isRegenerating ? (
                  <>
                    <Spinner />
                    Regenerating…
                  </>
                ) : promptDirty ||
                  paletteDirty ||
                  imageModel !== (d.trend_brief?.image_model ?? "fal_gpt_image_2") ||
                  bgRemoval !== (d.trend_brief?.background_removal_mode ?? null) ? (
                  "Regen with edit"
                ) : (
                  "Regen"
                )}
              </Button>
            </form>
            <form action={handleRemask}>
              <input type="hidden" name="id" value={d.id} />
              <input type="hidden" name="version_index" value={versionIndexValue} />
              <input
                type="hidden"
                name="background_removal_mode"
                value={bgRemoval ?? ""}
              />
              <Button
                type="submit"
                variant="ghost"
                disabled={isBusy || !active.unmasked_url}
                title={
                  !active.unmasked_url
                    ? "No unmasked image saved for this version — only full Regen works."
                    : "Re-run background removal on the displayed version. ~$0.02 vs ~$0.10–0.30 for full Regen."
                }
              >
                {isRemasking ? (
                  <>
                    <Spinner />
                    Re-masking…
                  </>
                ) : (
                  "Re-mask only · ~$0.02"
                )}
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

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
