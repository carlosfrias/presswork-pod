-- Orders table: idempotency enforced via UNIQUE constraint on etsy_order_id +
-- INSERT ... ON CONFLICT DO NOTHING. No claim_pending_* RPC needed here.
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  etsy_order_id TEXT UNIQUE NOT NULL,
  listing_id UUID REFERENCES listings(id),
  status TEXT DEFAULT 'received',
  printify_order_id TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  sale_price_usd NUMERIC,
  print_cost_usd NUMERIC,
  etsy_fees_usd NUMERIC,
  margin_usd NUMERIC GENERATED ALWAYS AS (
    sale_price_usd - COALESCE(print_cost_usd, 0) - COALESCE(etsy_fees_usd, 0)
  ) STORED,
  buyer_country TEXT,
  error_message TEXT,
  error_log JSONB,
  retry_count INT DEFAULT 0
);

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_printify_id ON orders(printify_order_id);

-- update_timestamp() defined in migration 001 — do not redefine
CREATE TRIGGER trg_orders_updated
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
