/**
 * Shared catalog for paid AI background-removal backends. Used by the Design
 * review-card picker (currently the only surface; if Builder or Overview
 * grow this option later, they can reuse this catalog and the
 * BgRemovalPicker component).
 *
 * The two entries here are the PAID FALLBACKS — the global default is
 * in-process rembg ("local"), surfaced in the picker as the null-fallback
 * "Local" chip. The designer picks BiRefNet or Bria from this catalog only
 * when local leaves halos or eats fine detail and they want to spend the
 * money on a fal-hosted AI cutout instead.
 *
 * The id values mirror the Python BackgroundRemovalMode Literal and the DB
 * CHECK constraint on trend_briefs.background_removal_mode. NULL on the
 * brief = "use the global runtime flag" (currently "local").
 */

export type BgRemovalModeId = "birefnet" | "bria";

export interface BgRemovalOption {
  id: BgRemovalModeId;
  label: string;
  blurb: string;
}

export const BG_REMOVAL_OPTIONS: readonly BgRemovalOption[] = [
  {
    id: "birefnet",
    label: "BiRefNet",
    blurb:
      "fal-ai/birefnet/v2 — paid AI fallback (~$0.02/image). Matting-quality cutout — best preserves fine edges (hair, fur, wisps) when local rembg eats detail. Can leave faint color halos on saturated backgrounds.",
  },
  {
    id: "bria",
    label: "Bria",
    blurb:
      "fal-ai/bria/background/remove — paid AI fallback (~$0.018/image), commercial RMBG 2.0. Cleaner edges on flat-color backgrounds when local rembg leaves halos. Sometimes loses very delicate detail.",
  },
] as const;

export const BG_REMOVAL_IDS = BG_REMOVAL_OPTIONS.map((m) => m.id);

export function getBgRemoval(id: string | null | undefined): BgRemovalOption | null {
  if (!id) return null;
  return BG_REMOVAL_OPTIONS.find((m) => m.id === id) ?? null;
}

/** Normalize an unknown form value to a valid bg-removal id or null. */
export function parseBgRemoval(raw: unknown): BgRemovalModeId | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return (BG_REMOVAL_IDS as readonly string[]).includes(raw)
    ? (raw as BgRemovalModeId)
    : null;
}
