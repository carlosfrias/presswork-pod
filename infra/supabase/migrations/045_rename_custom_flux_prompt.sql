-- Rename trend_briefs.custom_flux_prompt → image_description.
--
-- The column was named for the original FLUX-only path. It's now read by
-- all three image-model backends (FLUX Pro 1.1, gpt-image-2, nano-banana-2)
-- and the default is no longer FLUX. The "custom_flux_prompt" name was
-- misleading both in code and in the dashboard's Regen-with-edit textarea
-- label.
--
-- This migration ships in lockstep with code that:
--   1. Drops the FLUX incantation validator (FLUX_REQUIRED_TERMS) — the
--      "print on demand design / vector-style" / mandatory bg phrases that
--      FLUX Pro 1.1 no longer needs per current operator observation.
--   2. Renames every TS/Python reference to image_description.
--   3. Updates the dashboard form-field name and UI label.
--
-- Backward compatibility: no downstream consumers other than this repo;
-- coordinated single deploy.

ALTER TABLE trend_briefs RENAME COLUMN custom_flux_prompt TO image_description;

COMMENT ON COLUMN trend_briefs.image_description IS
  'Operator/Builder-authored image description used verbatim by Design. Model-agnostic — applies whether the brief targets FLUX, gpt-image-2, or nano-banana-2. Design appends only print-readiness clauses (palette, framing, background, singular subject) at preprocessing time; it does not re-synthesize.';
