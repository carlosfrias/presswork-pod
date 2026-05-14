-- Repair the realtime RLS gating chain.
--
-- Migrations 031 and 043 introduced `_read_allowlist` SELECT policies on
-- agent_runs, design_packages, trend_briefs, listings of the form:
--
--   USING ((auth.jwt() ->> 'email') IN (SELECT email FROM dashboard_allowed_emails))
--
-- The subquery is evaluated in the AUTHENTICATED user's RLS context. But
-- dashboard_allowed_emails itself has RLS enabled with zero policies
-- (deny-all for non-service-role). So the subquery returns 0 rows for any
-- browser session, the IN check is always false, and Realtime delivers no
-- events to the dashboard. The pending → processing transition appears
-- "stuck" until the page's revalidate=30 timer or a manual refresh fires.
--
-- Empirically verified via:
--   SET LOCAL ROLE authenticated;
--   SET LOCAL "request.jwt.claims" = '{"email":"ben.bracamonte@gmail.com"}';
--   SELECT count(*) FROM dashboard_allowed_emails;  -- returns 0
--
-- Fix: let an authenticated user see ONLY their own row in
-- dashboard_allowed_emails. That makes the subquery resolve correctly for
-- legitimate operators without leaking the rest of the allowlist (other
-- operator emails remain hidden). Service role still bypasses, so the
-- table is still effectively service-role-write-only.

DROP POLICY IF EXISTS dashboard_allowed_emails_self_read ON dashboard_allowed_emails;
CREATE POLICY dashboard_allowed_emails_self_read
  ON dashboard_allowed_emails FOR SELECT TO authenticated
  USING (email = (auth.jwt() ->> 'email'));
