-- Pre-mask image URL — the same canvas-padded design as `image_url` but
-- without birefnet (or rembg) applied. The Design page surfaces both so the
-- operator can flip between them to verify the mask cut cleanly.
--
-- Nullable for backfill compat. Newly-finished designs from main.py write both
-- columns; older rows leave this NULL and the dashboard falls back gracefully.

ALTER TABLE design_packages
  ADD COLUMN image_url_unmasked TEXT NULL;
