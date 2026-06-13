-- 059_etsy_refresh_lock_revoke_public.sql — fix the ineffective REVOKE in 058.
--
-- Postgres grants EXECUTE to PUBLIC by default, so migration 058's
-- "REVOKE EXECUTE ... FROM anon, authenticated" left the PUBLIC grant intact:
-- anon and authenticated still inherited EXECUTE. Because etsy_refresh_lock is
-- SECURITY DEFINER and RETURNS the OAuth access/refresh tokens, any caller with
-- the anon key could invoke it via PostgREST rpc and read the tokens.
--
-- This migration revokes EXECUTE from PUBLIC (the effective deny) and grants it
-- explicitly to service_role (the only intended caller). 058 itself was also
-- corrected for fresh deploys; this migration remediates environments where 058
-- was already applied before the correction. All statements are idempotent.

REVOKE EXECUTE ON FUNCTION public.etsy_refresh_lock(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.etsy_refresh_lock(integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.etsy_refresh_lock(integer, integer) TO service_role;
