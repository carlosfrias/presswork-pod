-- 060_atomic_listing_retry.sql — atomic listing retry_count increment (AUDIT_5 M6).
--
-- The race this prevents:
--   publisher.ts increments retry_count read-then-write: publishOne re-reads
--   retry_count in its catch then writes +1; resumePublish uses the retry_count
--   it read BEFORE the publish attempt even started. Two overlapping runs (the
--   dashboard "Publish now" + a CLI run, or rapid re-runs) can both compute the
--   same next value, so a row gets extra lives beyond MAX_RETRIES and the
--   terminal-error Slack alert is delayed or skipped.
--
-- Fix — do the increment AND the pending/error decision in one UPDATE, server
-- side, returning the new count. Concurrent callers serialize on the row lock
-- the UPDATE takes, so each sees the other's increment.
--
--   p_retry_status is the status to set while retries remain ('pending' for
--   publishOne, 'pending_publish' for resumePublish). When the incremented
--   count reaches p_max_retries the row is parked at 'error' instead. The
--   listings status CHECK constraint (migration 034) rejects any bad
--   p_retry_status, surfacing as an error the caller's alert path handles.
--
--   RETURNING retry_count yields the POST-increment value; a vanished row
--   (concurrent delete) matches nothing and the function returns NULL, which
--   the caller treats as a failed write (logs + alerts, never silently drops).

CREATE OR REPLACE FUNCTION increment_listing_retry(
  p_listing_id    UUID,
  p_error_message TEXT,
  p_retry_status  TEXT,
  p_max_retries   INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE public.listings
  SET retry_count   = COALESCE(retry_count, 0) + 1,
      error_message = p_error_message,
      status        = CASE
                        WHEN COALESCE(retry_count, 0) + 1 < p_max_retries
                          THEN p_retry_status
                        ELSE 'error'
                      END
  WHERE id = p_listing_id
  RETURNING retry_count INTO v_new_count;

  RETURN v_new_count; -- NULL if no row matched (listing concurrently deleted)
END;
$$;

-- Intentional deny (AUDIT_5 L8 hygiene): Postgres grants EXECUTE to PUBLIC by
-- default, so "REVOKE ... FROM anon, authenticated" alone is INEFFECTIVE — those
-- roles still inherit EXECUTE via PUBLIC. Revoke from PUBLIC (the effective
-- deny), then grant EXECUTE explicitly to service_role (the only intended
-- caller — the Listing agent connects with the service role). All idempotent.
REVOKE EXECUTE ON FUNCTION increment_listing_retry(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_listing_retry(UUID, TEXT, TEXT, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_listing_retry(UUID, TEXT, TEXT, INTEGER) TO service_role;
