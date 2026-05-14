-- Add listings to the realtime publication so the Listings page can
-- live-update review cards as the agent moves rows through
-- pending → needs_review → pending_publish → publishing → active.
-- Same rationale as migration 039 for design_packages: RLS on listings
-- (migration 031) still gates row-level visibility over the WebSocket;
-- adding to the publication just enables delivery.

ALTER PUBLICATION supabase_realtime ADD TABLE listings;
