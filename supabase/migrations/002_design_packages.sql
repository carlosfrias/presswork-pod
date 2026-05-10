CREATE TABLE design_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  trend_brief_id UUID REFERENCES trend_briefs(id),
  status TEXT DEFAULT 'pending',
  image_url TEXT,
  mockup_urls TEXT[],
  printify_blueprint_id INT,
  printify_variant_ids INT[],
  fal_prompt TEXT,
  metadata JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0
);

CREATE INDEX idx_design_packages_status ON design_packages(status);

CREATE TRIGGER trg_design_packages_updated
  BEFORE UPDATE ON design_packages
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE OR REPLACE FUNCTION claim_pending_trend_brief()
RETURNS SETOF trend_briefs AS $$
  UPDATE trend_briefs
  SET status = 'processing'
  WHERE id = (
    SELECT id FROM trend_briefs
    WHERE status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$ LANGUAGE sql;
