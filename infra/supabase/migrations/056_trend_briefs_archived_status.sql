-- Add 'archived' to the trend_briefs.status CHECK constraint (migration 056).
--
-- Purpose: operator-only parking state for Builder-queue briefs. A brief at
-- 'archived' was at 'needs_description' and the operator chose to defer it
-- rather than continue building. It leaves the active Builder queue and is
-- excluded from the Ledger watchdog's counts. Archived briefs are restorable
-- ('archived' → 'needs_description') and deletable from the dashboard.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + re-ADD matches the pattern used
-- in migration 034.

ALTER TABLE trend_briefs DROP CONSTRAINT IF EXISTS trend_briefs_status_check;
ALTER TABLE trend_briefs ADD CONSTRAINT trend_briefs_status_check
  CHECK (status IN (
    'pending',
    'needs_review',
    'needs_description',
    'approved',
    'processing',
    'done',
    'error',
    'archived'
  ));
