-- orders.etsy_tracking_submitted_at: marks rows where we've confirmed Etsy
-- received the tracking PATCH. Previously a failed Etsy submitTracking after
-- the webhook had already flipped status='shipped' would strand the order —
-- the tracking_poller filtered on status='submitted' only and never retried.
-- With this column the poller can re-attempt shipped+unsent rows safely.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS etsy_tracking_submitted_at TIMESTAMPTZ;
