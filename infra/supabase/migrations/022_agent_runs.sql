-- Trail of dashboard-triggered agent runs. The dashboard's "Run [agent] now"
-- button spawns the agent as a local subprocess and writes one row here per
-- invocation: when it started, when it finished, exit code, and the tail of
-- stdout/stderr for quick triage.
--
-- This table is only written when DASHBOARD_LOCAL_TRIGGERS_ENABLED=true
-- (i.e. running the dashboard on a machine that has the Python/Node code
-- locally). On Vercel deploys the button shows the CLI command instead and
-- this table stays empty.

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent TEXT NOT NULL,                  -- scout | design | listing | ledger
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  exit_code INT,
  stdout_tail TEXT,                     -- last ~4KB of stdout
  stderr_tail TEXT,                     -- last ~4KB of stderr
  triggered_by TEXT                     -- email of the dashboard user who clicked Run
);

CREATE INDEX idx_agent_runs_agent_started ON agent_runs (agent, started_at DESC);
