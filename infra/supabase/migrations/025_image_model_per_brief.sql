-- Per-brief image-gen backend + quality selection.
--
-- The Design agent now supports two fal-hosted backends:
--   1. fal_flux_pro      → fal-ai/flux-pro/v1.1 (legacy, needs ritual-phrase
--                          prompts and an aura-sr upscaler pass).
--   2. fal_gpt_image_2   → openai/gpt-image-2  (new default; better literal-brief
--                          adherence, large native output, skips aura-sr).
--
-- image_model picks the backend; image_quality is gpt-image-2's quality tier
-- (low | medium | high). FLUX ignores image_quality.
--
-- Default is fal_gpt_image_2 — both the dashboard inject form and Scout's
-- auto-discovered briefs land on the new model unless an operator opts out.
-- Existing rows backfill to the same default (we made the same call when we
-- removed the FLUX-required-phrase boilerplate; a re-run of any legacy brief
-- now goes through gpt-image-2 with a fresh prompt build).

ALTER TABLE trend_briefs
  ADD COLUMN image_model TEXT NOT NULL DEFAULT 'fal_gpt_image_2'
    CHECK (image_model IN ('fal_flux_pro', 'fal_gpt_image_2'));

ALTER TABLE trend_briefs
  ADD COLUMN image_quality TEXT NULL
    CHECK (image_quality IS NULL OR image_quality IN ('low', 'medium', 'high'));
