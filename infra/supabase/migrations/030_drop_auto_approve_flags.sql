-- Remove the auto-approve runtime flags entirely.
--
-- Policy: every agent in the pipeline pauses for human review. There is no
-- bypass — no scout_auto_approve_enabled, no design_auto_approve_enabled, no
-- HUMAN_REVIEW_ENABLED env var. Scout, Builder, Design, and Listing all gate
-- their output at needs_review.
--
-- The flag rows are deleted (not just set to false) so a future toggle in
-- Supabase doesn't silently re-enable a code path that no longer exists. The
-- agents that read these flags have been removed (packages/scout/main.py,
-- packages/design/main.py).

DELETE FROM runtime_flags
WHERE key IN ('scout_auto_approve_enabled', 'design_auto_approve_enabled');
