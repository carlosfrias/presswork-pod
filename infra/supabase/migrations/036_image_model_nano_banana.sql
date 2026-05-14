-- Add fal-ai/nano-banana-2 (Google's Gemini-3-based image model on fal.ai)
-- as a third backend alongside fal_flux_pro and fal_gpt_image_2.
--
-- Two changes:
--   1. Widen the CHECK constraint on trend_briefs.image_model to permit the
--      new value. Postgres can't ALTER a CHECK in place — drop and recreate.
--   2. Seed a runtime flag the dashboard reads as the default model for new
--      briefs. Operator can change it from the Overview flags rail without
--      a redeploy. Falls back to 'fal_gpt_image_2' if the row is missing.

ALTER TABLE trend_briefs
  DROP CONSTRAINT trend_briefs_image_model_check;

ALTER TABLE trend_briefs
  ADD CONSTRAINT trend_briefs_image_model_check
    CHECK (image_model IN (
      'fal_flux_pro',
      'fal_gpt_image_2',
      'fal_nano_banana_2'
    ));

INSERT INTO runtime_flags (key, value, description) VALUES
  (
    'default_image_model',
    '"fal_gpt_image_2"',
    'Default image-generation backend for new briefs. One of: fal_gpt_image_2 (OpenAI gpt-image-2, $0.012-$0.30/image by quality tier), fal_nano_banana_2 (Google Gemini-3 on fal, $0.08/image at 1K), fal_flux_pro (fal FLUX Pro 1.1, $0.05/image).'
  )
ON CONFLICT (key) DO NOTHING;
