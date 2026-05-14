-- Introduce a third background-removal mode: 'local' (in-process rembg U²-Net).
--
-- Adds 'local' to the CHECK constraint on trend_briefs.background_removal_mode
-- and flips the global runtime_flags.background_removal_mode default from
-- "bria" to "local". The two fal backends (birefnet v2, bria 2.0) stay as
-- per-brief opt-ins for designs where local leaves halos or eats fine detail.
--
-- Why: every Design run since migration 037 has spent $0.018-$0.02 on bg
-- removal that local rembg would have handled fine for the vast majority of
-- prints. Local was the original implementation (commit f3f16a8) before the
-- pipeline went URL-threaded; we're bringing it back as the default and
-- demoting the paid backends to designer-opt-in.
--
-- Backward compatibility: rows with NULL keep using the flag (now "local");
-- rows with explicit 'birefnet' or 'bria' overrides keep those.

ALTER TABLE trend_briefs
  DROP CONSTRAINT trend_briefs_background_removal_mode_check;

ALTER TABLE trend_briefs
  ADD CONSTRAINT trend_briefs_background_removal_mode_check
    CHECK (background_removal_mode IS NULL OR background_removal_mode IN ('birefnet', 'bria', 'local'));

COMMENT ON COLUMN trend_briefs.background_removal_mode IS
  'Per-brief override for the background cutout backend. NULL = fall back to runtime_flags.background_removal_mode (currently "local").';

UPDATE runtime_flags
SET value = '"local"',
    description = 'Background removal backend: "local" (in-process rembg, free) | "birefnet" (fal.ai v2, paid) | "bria" (fal.ai RMBG 2.0, paid).',
    updated_at = now()
WHERE key = 'background_removal_mode';
