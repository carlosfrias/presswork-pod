-- Add the three tables the dashboard subscribes to via Supabase Realtime to
-- the supabase_realtime publication. Without this, postgres_changes events
-- never fire and the dashboard's WebSocket subscriptions silently see no
-- updates. RLS posture is unchanged (these tables are RLS-disabled per the
-- service-role-only architecture; Realtime delivers the same rows the anon
-- key can already SELECT).
--
-- Replaces the previous 5-second polling pattern in DesignReviewNotifier and
-- AgentRunStatus — those components were generating one POST /design per tab
-- per cycle just to observe state that changes at most a few times an hour.
ALTER PUBLICATION supabase_realtime ADD TABLE trend_briefs;
ALTER PUBLICATION supabase_realtime ADD TABLE design_packages;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_runs;
