-- 047_listings_last_pushed_at.sql
--
-- Tracks when the operator last pushed local copy edits on an active listing
-- to Etsy via PATCH. Used by the dashboard to enable/disable the "Push to
-- Etsy" button (enabled when listings.updated_at > listings.last_pushed_at).
--
-- NULL until the first push. Backfill any currently-active listings to their
-- updated_at so the button doesn't immediately show "unpushed changes" for
-- listings that haven't been edited since publish.

ALTER TABLE listings ADD COLUMN last_pushed_at TIMESTAMPTZ;

COMMENT ON COLUMN listings.last_pushed_at IS
  'When the operator last pushed local copy edits to Etsy via PATCH. NULL until the first push. Used by the dashboard to indicate unpushed changes (updated_at > last_pushed_at).';

UPDATE listings SET last_pushed_at = updated_at WHERE status = 'active';
