-- Per-agent "manual mode" toggle. When false (default), the dashboard's
-- approve action also auto-spawns the next agent locally so work flows
-- straight through. When true, the user has to click the Run button on the
-- next agent's page (or run the CLI command). Only meaningful when
-- DASHBOARD_LOCAL_TRIGGERS_ENABLED=true — on cloud deploys auto-spawn
-- silently no-ops.
--
-- Only Design and Listing have a triggering upstream event (an approve).
-- Scout and Ledger don't have an upstream "something landed" event, so a
-- manual-mode toggle for them wouldn't do anything yet.

INSERT INTO runtime_flags (key, value, description) VALUES
  (
    'design_manual_mode_enabled',
    'false',
    'When false (default): approving a brief auto-spawns Design locally. When true: you click Run Design on the dashboard.'
  ),
  (
    'listing_manual_mode_enabled',
    'false',
    'When false (default): approving a design auto-spawns Listing locally. When true: you click Run Listing on the dashboard.'
  )
ON CONFLICT (key) DO NOTHING;
