-- Scope the niche+day uniqueness to Scout-research briefs only.
--
-- Migration 033 added uniq_trend_briefs_niche_day to protect Scout from
-- race-condition duplicates (two concurrent Scout runs both inserting the
-- same niche on the same UTC day). The index was unconditional.
--
-- The Builder agent (added later) spawns CHILD briefs that clone the parent's
-- niche when the operator clicks "Send to Design", and createManualBrief
-- defaults to niche='original design'. Both legitimately need to insert
-- multiple same-niche rows on the same day, and both currently fail with
-- 23505 against the unconditional index.
--
-- Fix: rebuild the index as PARTIAL, scoped to rows where claude_analysis
-- has no 'source' key. Scout writes claude_analysis without 'source', so its
-- inserts are still indexed and still race-protected. Builder spawn sets
-- source='builder_spawn' and manual sets source='builder_manual' — both
-- excluded from the index.
--
-- jsonb ->> is IMMUTABLE, so the predicate is valid in an index expression.
--
-- The RPC insert_trend_brief_if_no_recent is untouched: its 7-day window
-- check still treats Builder rows as "this niche is already in flight",
-- which is the right behavior (operator iteration takes precedence over
-- Scout re-research).

DROP INDEX IF EXISTS uniq_trend_briefs_niche_day;

CREATE UNIQUE INDEX uniq_trend_briefs_niche_day
  ON trend_briefs (niche, ((created_at AT TIME ZONE 'UTC')::date))
  WHERE (claude_analysis->>'source') IS NULL;
