-- 058_etsy_refresh_lock.sql — serialize Etsy OAuth refresh across processes (AUDIT_5 H3).
--
-- The race this prevents:
--   Etsy rotates the refresh_token on EVERY refresh. The new refresh_token must
--   be persisted or the grant bricks: the next refresh uses a dead token and
--   Etsy returns invalid_grant, forcing a full manual re-authorization.
--
--   etsy-auth.ts already coalesces concurrent refreshes WITHIN a process
--   (module-level `pendingRefresh`). But Listing CLI, the dashboard, and Ledger
--   run as SEPARATE processes. If two of them both see a near-expiry token and
--   both POST to Etsy's token endpoint, each rotation invalidates the other's
--   refresh_token — whichever write lands last persists a token Etsy has already
--   killed. Next tick: invalid_grant. Per-process coalescing cannot see across
--   process boundaries, so it cannot stop this.
--
-- Why an advisory lock alone is not enough:
--   pg_advisory_xact_lock is transaction-scoped — it releases the instant this
--   RPC returns, BEFORE the caller makes the 1-5s Etsy HTTP POST. A second
--   process can then take the lock, re-read the still-stale row, and double
--   refresh. The advisory lock only serializes the DECISION, not the external
--   call. We close that window with a lease.
--
-- Fix — advisory lock + lease sentinel:
--   The RPC takes a transaction-scoped advisory lock on a CONSTANT key
--   (hashtext of 'etsy_oauth_refresh') so only one process decides at a time,
--   re-reads the etsy_oauth config row INSIDE the same transaction, and then:
--     (a) token fresh                       -> return it, needs_refresh=false, wait=false
--     (b) stale BUT refreshing_until in the
--         future (a peer holds the lease)   -> needs_refresh=false, wait=true (no token yet)
--     (c) stale AND no active lease         -> stamp refreshing_until = now()+lease
--                                              on the config row, return
--                                              needs_refresh=true, wait=false (winner)
--   The lease auto-expires (case b only holds while refreshing_until is future),
--   so a crashed winner cannot block refresh forever — the next caller sees the
--   expired lease, becomes the new winner, and proceeds. setEtsyTokens clears
--   refreshing_until in the same write that lands the new token, releasing the
--   lease the instant the rotated token is durable.
--
--   Mirrors the advisory-lock pattern from 033_scout_dedupe_atomic.sql.

CREATE OR REPLACE FUNCTION etsy_refresh_lock(
  p_buffer_seconds INTEGER DEFAULT 60,
  p_lease_seconds  INTEGER DEFAULT 30
)
RETURNS TABLE (
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  needs_refresh BOOLEAN,
  wait          BOOLEAN,
  has_row       BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value           JSONB;
  v_expires_at      TIMESTAMPTZ;
  v_refreshing_until TIMESTAMPTZ;
  v_stale           BOOLEAN;
BEGIN
  -- Serialize all refresh decisions across processes. Constant key so every
  -- caller contends on the same lock regardless of args. Released on commit
  -- (i.e. when this function returns).
  PERFORM pg_advisory_xact_lock(hashtext('etsy_oauth_refresh'));

  SELECT value INTO v_value
  FROM public.config
  WHERE key = 'etsy_oauth';

  IF v_value IS NULL THEN
    -- No persisted token row yet (first-ever refresh; seed comes from env in
    -- the caller). Report needs_refresh so the caller proceeds with the POST.
    -- No row to stamp a lease on; in-process coalescing covers first-run races.
    access_token  := NULL;
    refresh_token := NULL;
    expires_at    := NULL;
    needs_refresh := TRUE;
    wait          := FALSE;
    has_row       := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_expires_at       := (v_value->>'expiresAt')::TIMESTAMPTZ;
  v_refreshing_until := (v_value->>'refreshingUntil')::TIMESTAMPTZ;

  access_token  := v_value->>'accessToken';
  refresh_token := v_value->>'refreshToken';
  expires_at    := v_expires_at;
  has_row       := TRUE;

  -- Stale (or unparseable expiry) => needs refresh.
  v_stale := v_expires_at IS NULL
    OR v_expires_at <= now() + make_interval(secs => p_buffer_seconds);

  IF NOT v_stale THEN
    -- (a) Fresh token (a peer already rotated, or it was never stale). Use it.
    needs_refresh := FALSE;
    wait          := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_refreshing_until IS NOT NULL AND v_refreshing_until > now() THEN
    -- (b) Stale, but a peer holds an unexpired lease and is mid-refresh. Tell
    -- the caller to wait and re-poll rather than launching a competing POST.
    needs_refresh := FALSE;
    wait          := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- (c) Stale and no active lease (none set, or it expired because the prior
  -- winner crashed). Claim the lease and become the winner. The stamp is
  -- committed when this RPC's transaction commits, so a concurrent caller that
  -- next acquires the advisory lock will observe it and take the wait path.
  -- Format the lease as an explicit UTC ISO-8601 string. to_char renders a
  -- TIMESTAMPTZ in the session TimeZone GUC, so without `AT TIME ZONE 'UTC'` a
  -- non-UTC session would emit local-time components with a literal "Z" suffix —
  -- read back via ::TIMESTAMPTZ that is misinterpreted as UTC and the lease is
  -- off by the session offset. AT TIME ZONE 'UTC' pins the components to UTC so
  -- the "Z" is correct on any session (Supabase cloud is UTC; this keeps it safe
  -- for any local/non-UTC deployment too).
  UPDATE public.config
  SET value = value || jsonb_build_object(
        'refreshingUntil',
        to_char((now() + make_interval(secs => p_lease_seconds)) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
  WHERE key = 'etsy_oauth';

  needs_refresh := TRUE;
  wait          := FALSE;
  RETURN NEXT;
END;
$$;

-- Intentional deny: this RPC is SECURITY DEFINER and RETURNS the OAuth tokens, so
-- it must be service-role only. CAUTION: Postgres grants EXECUTE to PUBLIC by
-- default, so "REVOKE ... FROM anon, authenticated" alone is INEFFECTIVE — those
-- roles still inherit EXECUTE via PUBLIC and could read the tokens over PostgREST.
-- Revoke from PUBLIC (the effective deny), then grant EXECUTE explicitly to
-- service_role (the only intended caller). Migration 059 applies this same fix to
-- environments where 058 shipped before the correction.
REVOKE EXECUTE ON FUNCTION etsy_refresh_lock(INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION etsy_refresh_lock(INTEGER, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION etsy_refresh_lock(INTEGER, INTEGER) TO service_role;
