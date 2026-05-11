-- Add print_style classification to trend_briefs.
--
-- The Design agent needs to know whether a brief should be rendered as a
-- full-color (DTG / sublimation) design or a single-ink screen-print. Screen
-- print requires a second image-processing pass that strips the interior
-- negative space (e.g. the hole inside an "O", the gap between fingers) so the
-- shirt color shows through. Without this signal, rembg alone leaves those
-- interior whites opaque and the print has visible white islands.
--
-- Scout's Claude analyzer classifies each brief; Design reads the flag and
-- routes both the FLUX prompt and the post-processing pipeline accordingly.
--
-- Nullable, no default: existing pending rows stay NULL. The Design consumer
-- treats NULL as 'full_color' (the prior, existing behavior).
ALTER TABLE trend_briefs
  ADD COLUMN print_style TEXT
  CHECK (print_style IN ('full_color', 'screen_print'));
