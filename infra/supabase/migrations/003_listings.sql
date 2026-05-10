-- listings table: Listing Agent output, one row per design_package published to Etsy
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  design_package_id UUID REFERENCES design_packages(id),
  status TEXT DEFAULT 'pending', -- pending → needs_review → pending_publish → publishing → active | error
  etsy_listing_id BIGINT UNIQUE,
  title TEXT,
  description TEXT,
  tags TEXT[],
  price_usd NUMERIC,
  is_active BOOLEAN DEFAULT false,
  error_message TEXT,
  retry_count INT DEFAULT 0
);

CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_etsy_id ON listings(etsy_listing_id);

-- reuses update_timestamp() from migration 001 — do NOT redefine here
CREATE TRIGGER trg_listings_updated
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- config table: single-row store for rotating credentials (e.g. Etsy OAuth tokens)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER trg_config_updated
  BEFORE UPDATE ON config
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Atomically claims one design_package at status='done' and bumps it to 'processing'.
-- Mirrors claim_pending_trend_brief() from migration 002 using FOR UPDATE SKIP LOCKED.
-- The Listing agent owns the design_packages state machine from 'done' onward.
CREATE OR REPLACE FUNCTION claim_pending_design_package()
RETURNS SETOF design_packages AS $$
  UPDATE design_packages
  SET status = 'processing'
  WHERE id = (
    SELECT id FROM design_packages
    WHERE status = 'done'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$ LANGUAGE sql;
