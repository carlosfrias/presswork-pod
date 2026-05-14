-- Per-brief background-removal mode override.
--
-- Adds a nullable column on trend_briefs that lets the Design review-card
-- picker lock a specific brief to a specific cutout backend. NULL = "use
-- whatever the global background_removal_mode runtime flag currently says"
-- (existing behavior), so this migration is fully backward compatible —
-- every existing brief reads NULL and keeps using the global default.
--
-- Why a column instead of a JSONB key (like style):
--   - Python's main.py reads this on every Design run; a typed column is
--     simpler to validate and dispatch on than a JSONB extract.
--   - CHECK constraint prevents typos rotting downstream.
--   - Mirrors image_model's pattern exactly — same write/read story.

ALTER TABLE trend_briefs
  ADD COLUMN background_removal_mode TEXT NULL
    CHECK (background_removal_mode IS NULL OR background_removal_mode IN ('birefnet', 'bria'));

COMMENT ON COLUMN trend_briefs.background_removal_mode IS
  'Per-brief override for the background cutout backend. NULL = fall back to runtime_flags.background_removal_mode.';
