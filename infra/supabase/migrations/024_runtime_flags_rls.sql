-- runtime_flags gates human-review bypass and other security-sensitive agent
-- behavior (human_review_enabled, scout_auto_approve_enabled,
-- design_auto_approve_enabled, *_manual_mode_enabled). All reads/writes in
-- this codebase go through the service role, which bypasses RLS — so enabling
-- it here is defense-in-depth, not a behavior change.
--
-- This is the only RLS-enabled table in the schema. The rest of the project
-- relies on the service-role-only architecture documented in CLAUDE.md and
-- packages/dashboard/lib/supabase/server.ts. We single out runtime_flags
-- because an anon-key write here would silently disable the human-review gate
-- across the whole pipeline; no other table has that blast radius.
--
-- No policies are added: with RLS enabled and zero permissive policies, any
-- non-service-role session is deny-all by default.

ALTER TABLE runtime_flags ENABLE ROW LEVEL SECURITY;
