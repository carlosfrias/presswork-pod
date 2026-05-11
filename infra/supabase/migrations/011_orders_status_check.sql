-- orders.status CHECK constraint: prevents an undocumented value from sneaking
-- past the application layer (e.g. a future webhook handler bug writing a raw
-- Printify status string). Mirror of the documented state machine in CLAUDE.md:
--   received → submitted → shipped | error
--
-- The constraint is added as NOT VALID so existing rows aren't re-checked at
-- migration time (any pre-existing bad row should be visible in alerts; the
-- constraint enforces correctness only on future writes). A follow-up VALIDATE
-- run is safe once historical rows are cleaned.

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('received', 'submitted', 'shipped', 'error'))
  NOT VALID;
