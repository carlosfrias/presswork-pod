-- Cheap-regen flag for "background removal only" reruns.
--
-- Operator workflow: change the bg-removal chip on a Design review card,
-- click "Re-mask only" → this column flips to true and status='pending'.
-- The Design agent's re-mask sweep claims rows with this flag set, skips
-- image gen + Claude + upscale entirely, and runs only:
--   - download image_url_unmasked
--   - fal bg removal (with whatever brief.background_removal_mode resolves to)
--   - Pillow resize/pad
--   - upload new image_url
-- Costs ~$0.02 vs ~$0.10–0.30 for a full regen (5–15× cheaper).
--
-- The flag is also reset to false at the end of every successful re-mask so
-- the next regen on the same row goes through the full pipeline by default.

ALTER TABLE design_packages
  ADD COLUMN remask_only BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN design_packages.remask_only IS
  'When true, the Design agent will skip image gen and re-run only background removal + Pillow, reusing the existing image_url_unmasked. Reset to false after the re-mask completes.';

-- Partial index: only the small set of rows actively awaiting re-mask need
-- fast lookup. The full table is mostly remask_only=false (the default).
CREATE INDEX IF NOT EXISTS idx_design_packages_remask_pending
  ON design_packages (created_at)
  WHERE remask_only = true AND status = 'pending';
