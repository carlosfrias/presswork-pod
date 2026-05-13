-- Status CHECK constraints on trend_briefs, design_packages, listings
-- (AUDIT_4 H4).
--
-- Until now, only `orders` had a status CHECK (migrations 011 and 016).
-- The other three agent tables accept any text in `status`. The state
-- machine is enforced in TypeScript/Python only — a bad write or a
-- Supabase Studio edit can silently corrupt it.
--
-- Strategy (per AUDIT_4 plan):
--   1. Audit phase — emit RAISE NOTICE for every distinct non-conforming
--      status value found per table. Operator can see what was caught.
--   2. Backfill phase — UPDATE non-conforming rows to status='error' with
--      an explanatory error_message. Conservative routing: orphan rows
--      surface in dashboards instead of being auto-promoted to a "real"
--      state.
--   3. Constraint phase — ADD CONSTRAINT ... CHECK (no NOT VALID) so the
--      constraint is validated immediately. Pairs with the H5 procedural
--      lesson from migration 011's gap.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS first.

-- ── trend_briefs ──────────────────────────────────────────────────────
-- Legal: pending, needs_review, needs_description, approved, processing, done, error
-- `pending` retained for legacy rows; migration 021 backfilled them to
-- needs_review but we keep `pending` in the CHECK as defense-in-depth.

DO $$
DECLARE
  bad RECORD;
  total_bad INT := 0;
BEGIN
  FOR bad IN
    SELECT status, COUNT(*)::INT AS n
    FROM trend_briefs
    WHERE status NOT IN ('pending','needs_review','needs_description','approved','processing','done','error')
    GROUP BY status
  LOOP
    RAISE NOTICE '[034] trend_briefs has % rows with non-conforming status=%', bad.n, bad.status;
    total_bad := total_bad + bad.n;
  END LOOP;
  IF total_bad > 0 THEN
    RAISE NOTICE '[034] trend_briefs: backfilling % non-conforming rows to status=error', total_bad;
  END IF;
END $$;

UPDATE trend_briefs
SET
  status = 'error',
  error_message = COALESCE(error_message, '') ||
    CASE WHEN error_message IS NOT NULL THEN ' | ' ELSE '' END ||
    '[034] backfilled — original status: ' || status
WHERE status NOT IN ('pending','needs_review','needs_description','approved','processing','done','error');

ALTER TABLE trend_briefs DROP CONSTRAINT IF EXISTS trend_briefs_status_check;
ALTER TABLE trend_briefs ADD CONSTRAINT trend_briefs_status_check
  CHECK (status IN ('pending','needs_review','needs_description','approved','processing','done','error'));

-- ── design_packages ──────────────────────────────────────────────────
-- Legal: pending, needs_review, approved, processing, done, error

DO $$
DECLARE
  bad RECORD;
  total_bad INT := 0;
BEGIN
  FOR bad IN
    SELECT status, COUNT(*)::INT AS n
    FROM design_packages
    WHERE status NOT IN ('pending','needs_review','approved','processing','done','error')
    GROUP BY status
  LOOP
    RAISE NOTICE '[034] design_packages has % rows with non-conforming status=%', bad.n, bad.status;
    total_bad := total_bad + bad.n;
  END LOOP;
  IF total_bad > 0 THEN
    RAISE NOTICE '[034] design_packages: backfilling % non-conforming rows to status=error', total_bad;
  END IF;
END $$;

UPDATE design_packages
SET
  status = 'error',
  error_message = COALESCE(error_message, '') ||
    CASE WHEN error_message IS NOT NULL THEN ' | ' ELSE '' END ||
    '[034] backfilled — original status: ' || status
WHERE status NOT IN ('pending','needs_review','approved','processing','done','error');

ALTER TABLE design_packages DROP CONSTRAINT IF EXISTS design_packages_status_check;
ALTER TABLE design_packages ADD CONSTRAINT design_packages_status_check
  CHECK (status IN ('pending','needs_review','approved','processing','done','error'));

-- ── listings ──────────────────────────────────────────────────────────
-- Legal: pending, needs_review, pending_publish, publishing, active, error

DO $$
DECLARE
  bad RECORD;
  total_bad INT := 0;
BEGIN
  FOR bad IN
    SELECT status, COUNT(*)::INT AS n
    FROM listings
    WHERE status NOT IN ('pending','needs_review','pending_publish','publishing','active','error')
    GROUP BY status
  LOOP
    RAISE NOTICE '[034] listings has % rows with non-conforming status=%', bad.n, bad.status;
    total_bad := total_bad + bad.n;
  END LOOP;
  IF total_bad > 0 THEN
    RAISE NOTICE '[034] listings: backfilling % non-conforming rows to status=error', total_bad;
  END IF;
END $$;

UPDATE listings
SET
  status = 'error',
  error_message = COALESCE(error_message, '') ||
    CASE WHEN error_message IS NOT NULL THEN ' | ' ELSE '' END ||
    '[034] backfilled — original status: ' || status
WHERE status NOT IN ('pending','needs_review','pending_publish','publishing','active','error');

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('pending','needs_review','pending_publish','publishing','active','error'));
