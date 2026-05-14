/**
 * Shared catalog for the three image-generation backends the Design agent
 * dispatches to. One source of truth across:
 *   - Overview default-model flag editor
 *   - Builder model picker (FromScoutCard, ManualEntryForm)
 *   - Design review/regen model picker
 *   - Server-side validators (Zod enum, persisted style writes)
 *
 * The id values mirror the Python ImageModel Literal and the DB CHECK
 * constraint on trend_briefs.image_model — update all three together if a
 * new backend is added.
 */

export type ImageModelId = "fal_gpt_image_2" | "fal_nano_banana_2" | "fal_flux_pro";

export interface ImageModelOption {
  id: ImageModelId;
  label: string;
  blurb: string;
  costHint: string;
  supportsQuality: boolean;
}

export const IMAGE_MODEL_OPTIONS: readonly ImageModelOption[] = [
  {
    id: "fal_gpt_image_2",
    label: "GPT Image 2",
    blurb:
      "OpenAI gpt-image-2 on fal. Follows literal English prompts. Strong general-purpose default.",
    costHint: "~$0.01–$0.30 / image (low → high)",
    supportsQuality: true,
  },
  {
    id: "fal_nano_banana_2",
    label: "Nano Banana 2",
    blurb:
      "Google Gemini-3 on fal. Natural-English prompts. Strong with text/typography and multi-subject consistency.",
    costHint: "~$0.06–$0.12 / image (low → high)",
    supportsQuality: true,
  },
  {
    id: "fal_flux_pro",
    label: "FLUX Pro 1.1",
    blurb:
      "fal FLUX Pro 1.1. Ritual-phrase prompts required. Cheap, fast, good for graphic-poster registers.",
    costHint: "~$0.05 / image (+ aura-sr upscaler)",
    supportsQuality: false,
  },
] as const;

export const IMAGE_MODEL_IDS = IMAGE_MODEL_OPTIONS.map((m) => m.id);

export function getImageModel(id: string | null | undefined): ImageModelOption | null {
  if (!id) return null;
  return IMAGE_MODEL_OPTIONS.find((m) => m.id === id) ?? null;
}

/** Normalize an unknown value to a valid model id, falling back to default. */
export function parseImageModel(raw: unknown, fallback: ImageModelId = "fal_gpt_image_2"): ImageModelId {
  if (typeof raw !== "string") return fallback;
  return (IMAGE_MODEL_IDS as readonly string[]).includes(raw)
    ? (raw as ImageModelId)
    : fallback;
}

/**
 * Server-side initial-value extractor for the global default image model.
 * Looks up `default_image_model` from runtime_flags and narrows it through
 * parseImageModel with a fallback.
 */
export function deriveDefaultImageModel(
  flags: Array<{ key: string; value: unknown }>,
): ImageModelId {
  const row = flags.find((f) => f.key === "default_image_model");
  return parseImageModel(row?.value, "fal_gpt_image_2");
}
