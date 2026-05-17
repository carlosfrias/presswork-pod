-- 048_fix_claim_rpc_lock.sql
--
-- Bugfix for migration 046. The original CTE put `LEFT JOIN trend_briefs`
-- inside the locked SELECT, which made trend_briefs the nullable side of an
-- outer join — Postgres rejects FOR UPDATE in that position with:
--   "FOR UPDATE cannot be applied to the nullable side of an outer join".
--
-- Fix: lock design_packages alone in the inner SELECT, then look up the
-- price target via a separate join in the outer INSERT. trend_briefs is no
-- longer in the locked subquery, so the lock applies cleanly to the
-- design_packages row we're claiming.
--
-- Behavior is otherwise unchanged: the new claim RPC still creates a
-- listings row at status='pending' and returns it, atomically per-design
-- via FOR UPDATE SKIP LOCKED.

DROP FUNCTION IF EXISTS claim_pending_design_package();

CREATE FUNCTION claim_pending_design_package()
RETURNS SETOF listings AS $$
  WITH locked AS (
    SELECT dp.id, dp.trend_brief_id
    FROM design_packages dp
    WHERE dp.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM listings l WHERE l.design_package_id = dp.id
      )
    ORDER BY dp.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  INSERT INTO listings (design_package_id, status, price_usd)
  SELECT
    locked.id,
    'pending',
    COALESCE(tb.price_target_usd, 0)
  FROM locked
  LEFT JOIN trend_briefs tb ON tb.id = locked.trend_brief_id
  RETURNING *;
$$ LANGUAGE sql;
