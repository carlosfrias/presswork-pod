-- Ledger Agent rewrite: orders table is now metrics-only. Fulfillment moves to
-- Etsy's native Printify integration, so we no longer create Printify orders
-- or sync tracking from this codebase.
--
-- Dropping the Printify/tracking columns also drops the indexes/constraints
-- defined on them (idx_orders_printify_id from 004, uq_orders_printify_order_id
-- from 013).
--
-- Status enum tightens from ('received','submitted','shipped','error') to
-- ('logged','error'). Historical rows in the legacy states are migrated to
-- 'logged' so the new check constraint can be VALID immediately.
--
-- Explicit transaction: the UPDATE backfill and the ADD CONSTRAINT must
-- succeed together. Without this wrapper, a runner using --no-transaction (or
-- a partial replay) could leave the table without its status check after the
-- DROP CONSTRAINT step.

BEGIN;

ALTER TABLE orders
  DROP COLUMN IF EXISTS printify_order_id,
  DROP COLUMN IF EXISTS tracking_number,
  DROP COLUMN IF EXISTS tracking_url,
  DROP COLUMN IF EXISTS etsy_tracking_submitted_at;

UPDATE orders
SET status = 'logged'
WHERE status IN ('received', 'submitted', 'shipped');

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ALTER COLUMN status SET DEFAULT 'logged',
  ADD CONSTRAINT orders_status_check
    CHECK (status IN ('logged', 'error'));

COMMIT;
