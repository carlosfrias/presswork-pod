CREATE TABLE trend_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending',
  niche TEXT NOT NULL,
  style_keywords TEXT[],
  top_tags TEXT[],
  price_target_usd NUMERIC,
  color_palette TEXT[],
  raw_etsy_data JSONB,
  claude_analysis JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0
);

CREATE INDEX idx_trend_briefs_status ON trend_briefs(status);

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trend_briefs_updated
  BEFORE UPDATE ON trend_briefs
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
