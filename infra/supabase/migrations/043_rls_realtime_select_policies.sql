-- Add SELECT policies on design_packages, trend_briefs, and listings so the
-- dashboard's authenticated-session Realtime subscriptions actually receive
-- events.
--
-- Migration 031 enabled RLS on these tables with zero policies (deny-all for
-- non-service-role sessions). Migrations 039/040/041 then added them to the
-- supabase_realtime publication. Server-side page queries kept working
-- because they use the service-role key (bypasses RLS), but the browser's
-- Realtime subscription evaluates RLS against the post-image of each row
-- and silently drops every event — the dashboard's RealtimeRefresh
-- component appeared healthy but never received a single payload.
--
-- Visible symptom: Regen on the Design page wrote status='pending' and the
-- Python agent flipped it to 'processing' within ~2-5s, but the dashboard
-- only refreshed when Next.js's revalidate=30 timer caught the row much
-- later — making fast transitions look stuck.
--
-- Fix: mirror agent_runs_read_allowlist (migration 031) for each table.
-- Reads gated on the JWT email being in dashboard_allowed_emails, which is
-- the same allowlist the magic-link auth flow already checks. Service role
-- still bypasses these policies automatically; nothing new gains access.

DROP POLICY IF EXISTS design_packages_read_allowlist ON design_packages;
CREATE POLICY design_packages_read_allowlist
  ON design_packages FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'email') IN (SELECT email FROM dashboard_allowed_emails)
  );

DROP POLICY IF EXISTS trend_briefs_read_allowlist ON trend_briefs;
CREATE POLICY trend_briefs_read_allowlist
  ON trend_briefs FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'email') IN (SELECT email FROM dashboard_allowed_emails)
  );

DROP POLICY IF EXISTS listings_read_allowlist ON listings;
CREATE POLICY listings_read_allowlist
  ON listings FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'email') IN (SELECT email FROM dashboard_allowed_emails)
  );
