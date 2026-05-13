-- RLS baseline (AUDIT_4 C1).
--
-- Service-role architecture stands: every server-side path uses
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. The dashboard's browser
-- (anon-key) client only does two things — magic-link auth and a Realtime
-- subscription on `agent_runs` (see AgentRunStatus.tsx). Everywhere else
-- the dashboard reads via the server-side service client.
--
-- Previously only `runtime_flags` had RLS enabled (migration 024). All
-- other tables were RLS-disabled and would have been wide-open to anyone
-- holding the public anon key + project URL. This migration adds the
-- defense-in-depth layer so that "service-role only" is enforced by the
-- DB, not just by code reviews.
--
-- With RLS enabled and zero permissive policies, any non-service-role
-- session is deny-all by default. The one exception is `agent_runs`,
-- which the dashboard subscribes to via Realtime — we add a SELECT
-- policy gated on a dashboard_allowed_emails table.
--
-- Bootstrap: after this migration ships, seed your operator email via
-- service-role SQL:
--
--   INSERT INTO dashboard_allowed_emails (email)
--   VALUES ('ben.bracamonte@gmail.com')
--   ON CONFLICT (email) DO NOTHING;
--
-- Emails are operator-owned and not inlined here so the migration stays
-- environment-agnostic.

CREATE TABLE IF NOT EXISTS dashboard_allowed_emails (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dashboard_allowed_emails ENABLE ROW LEVEL SECURITY;
-- No policies → only the service role can read/write.

ALTER TABLE trend_briefs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage       ENABLE ROW LEVEL SECURITY;
ALTER TABLE config          ENABLE ROW LEVEL SECURITY;

-- The dashboard's AgentRunStatus component subscribes to row-level
-- changes on agent_runs via the anon key. Without a SELECT policy the
-- subscription receives no events. Restrict reads to authenticated
-- sessions whose JWT email is in the allowlist; service role bypasses
-- this policy automatically.
DROP POLICY IF EXISTS agent_runs_read_allowlist ON agent_runs;
CREATE POLICY agent_runs_read_allowlist
  ON agent_runs FOR SELECT TO authenticated
  USING (
    (auth.jwt() ->> 'email') IN (SELECT email FROM dashboard_allowed_emails)
  );
