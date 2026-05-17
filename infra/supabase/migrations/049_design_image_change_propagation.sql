-- 049_design_image_change_propagation.sql
--
-- Pipeline contract addendum: when a design's image_url changes (operator
-- edits the design via Regen / Re-mask / Replace image / etc.), the linked
-- listing's downstream artifacts (the Printify hidden product, the
-- Printify-generated mockups) are now stale — they were composited from
-- the OLD image.
--
-- Two-tier behavior:
--   - Listings at status='needs_review' or 'pending_publish' (the operator
--     hasn't pushed to Etsy yet) get pulled back to status='pending' with
--     printify_product_id cleared, so the next listing run rebuilds the
--     Printify product against the new image_url. error_message cleared
--     because we're starting fresh.
--   - Listings at status='active' (already on Etsy) are NOT touched here.
--     The dashboard surfaces a "stale artwork" badge by comparing
--     design_packages.updated_at against listings.design_synced_at; the
--     operator decides whether to click Recreate Printify product.
--   - Other statuses (pending, publishing, error) are left alone:
--       - pending: already queued; next run picks it up.
--       - publishing: in flight; touching it would race.
--       - error: operator already needs to look at it.
--
-- Note: the Printify hidden product created from the OLD image is left
-- orphaned in Printify's dashboard. We could call DELETE /products/{id}
-- here, but that's a side effect that doesn't belong in a Postgres trigger.
-- Operator can manually clean Printify if it matters.

ALTER TABLE listings ADD COLUMN design_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN listings.design_synced_at IS
  'When the listing''s Printify hidden product was last (re)created against the design''s image_url. Compared to design_packages.updated_at to detect stale artwork on active listings.';

-- Backfill: best-effort baseline. Any current listing with a Printify
-- product was created at-or-before its updated_at; setting design_synced_at
-- to updated_at means the staleness comparison won't false-positive
-- immediately after this migration runs.
UPDATE listings SET design_synced_at = updated_at WHERE printify_product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION on_design_image_changed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.image_url IS DISTINCT FROM OLD.image_url THEN
    UPDATE listings
    SET status = 'pending',
        printify_product_id = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE design_package_id = NEW.id
      AND status IN ('needs_review', 'pending_publish');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS design_image_change_trigger ON design_packages;

CREATE TRIGGER design_image_change_trigger
  AFTER UPDATE OF image_url ON design_packages
  FOR EACH ROW
  EXECUTE FUNCTION on_design_image_changed();
