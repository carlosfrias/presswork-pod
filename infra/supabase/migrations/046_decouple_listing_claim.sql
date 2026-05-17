-- 046_decouple_listing_claim.sql
--
-- Pipeline contract: data flows downstream (Design → Listing). Listing must
-- never write to design_packages.status. The old claim RPC mutated design
-- status (approved → processing → done) as the atomic-claim mechanism, which
-- (a) made design.status visibly churn whenever Listing ran, and (b) bled
-- listing-side errors back upstream when failures wrote 'error' to design.
--
-- New claim RPC: insert a listings row as the claim itself. The atomic lock
-- is on the SELECT inside a CTE (FOR UPDATE SKIP LOCKED). The listings INSERT
-- happens inside the same CTE chain so two concurrent callers never both
-- claim the same design. Returns the new listings row; caller fetches the
-- design separately by design_package_id.
--
-- design_packages.status now only ever transitions on Design's own actions:
--   needs_review → approved (operator approves on dashboard)
-- Status values 'processing' and 'done' remain in the schema for back-compat
-- with old rows but are no longer written.

DROP FUNCTION IF EXISTS claim_pending_design_package();

CREATE FUNCTION claim_pending_design_package()
RETURNS SETOF listings AS $$
  WITH locked AS (
    SELECT dp.id, COALESCE(tb.price_target_usd, 0) AS price
    FROM design_packages dp
    LEFT JOIN trend_briefs tb ON tb.id = dp.trend_brief_id
    WHERE dp.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM listings l WHERE l.design_package_id = dp.id
      )
    ORDER BY dp.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  INSERT INTO listings (design_package_id, status, price_usd)
  SELECT id, 'pending', price FROM locked
  RETURNING *;
$$ LANGUAGE sql;

-- Backfill: under the new contract design.status is owned by Design only.
-- Anything at processing/done from old runs becomes approved again. Won't
-- be re-claimed because they already have listings rows (NOT EXISTS guard
-- in the new RPC blocks duplicate claims for the same design).
UPDATE design_packages
SET status = 'approved',
    error_message = NULL,
    updated_at = now()
WHERE status IN ('processing', 'done');
