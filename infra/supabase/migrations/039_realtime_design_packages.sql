-- Re-add design_packages to the realtime publication so the dashboard can
-- live-update Design review cards as the agent moves rows through
-- pending → processing → needs_review.
--
-- Migration 032 dropped this table from the publication during the AUDIT_4
-- trim ("fewer surfaces, fewer rules") because nothing was subscribing.
-- The Design page now subscribes via DesignRealtimeRefresh.tsx so the
-- security argument is unchanged — RLS on design_packages (migration 031)
-- still gates which rows reach which clients over the WebSocket.

ALTER PUBLICATION supabase_realtime ADD TABLE design_packages;
