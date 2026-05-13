-- Trim supabase_realtime publication to the actually-subscribed table
-- (AUDIT_4 C2).
--
-- Migration 027 added trend_briefs, design_packages, and agent_runs to
-- the realtime publication. A grep of packages/dashboard/** finds only
-- one subscription: AgentRunStatus.tsx watches `agent_runs`. The other
-- two tables are broadcast over the WebSocket but nothing listens.
--
-- Under RLS-disabled (pre-031) anyone with the public anon key could
-- subscribe to those streams and harvest prompts, image URLs, owner
-- emails, and agent stdout/stderr tails. After 031 enables RLS and
-- denies anon SELECT on these tables, Realtime delivery is gated by
-- the same RLS policies — but the safest answer is to drop the unused
-- tables from the publication entirely. Fewer surfaces, fewer rules.
--
-- agent_runs stays in the publication. The 031 SELECT policy
-- (allowlist-gated) controls who can receive its events.

ALTER PUBLICATION supabase_realtime DROP TABLE trend_briefs;
ALTER PUBLICATION supabase_realtime DROP TABLE design_packages;
