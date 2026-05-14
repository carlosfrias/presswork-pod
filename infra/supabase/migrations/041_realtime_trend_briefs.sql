-- Re-add trend_briefs to the realtime publication so the Builder page can
-- live-update the from-Scout queue. Briefs move through
--   needs_review → needs_description → approved → processing → done
-- and the queue card needs to reflect those transitions without a refresh.
--
-- Same security argument as migration 039 / 040: RLS (migration 031) still
-- gates row visibility — adding to the publication only enables delivery
-- of the rows the operator session was already allowed to SELECT.
--
-- Dropped in 032 because nothing was subscribing at the time; the Builder
-- and Scout pages now do via RealtimeRefresh.

ALTER PUBLICATION supabase_realtime ADD TABLE trend_briefs;
