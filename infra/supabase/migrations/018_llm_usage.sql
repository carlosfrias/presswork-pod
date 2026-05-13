-- Per-call consumption log for LLM and image-gen APIs. The dashboard sums this
-- to show "what did we spend today / this week / this month" per provider,
-- which is more accurate than count-times-unit-cost estimates because retries,
-- cache hits, and fallback paths all change the real call count.
--
-- This is a metrics table — writes are fire-and-forget from agent code paths.
-- Never block a pipeline action on a write to this table.

CREATE TABLE llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent TEXT NOT NULL,        -- scout | design | listing | ledger
  provider TEXT NOT NULL,     -- anthropic | fal | etsy | printify
  operation TEXT NOT NULL,    -- e.g. analyze_listings, flux_pro, aura_sr, birefnet, copywriter
  cost_usd NUMERIC,           -- best effort; nullable when unknown
  input_tokens INT,
  output_tokens INT,
  metadata JSONB,             -- model, latency_ms, record_id, cache_hit, etc.
  error TEXT
);

CREATE INDEX idx_llm_usage_created_at ON llm_usage (created_at DESC);
CREATE INDEX idx_llm_usage_agent_provider ON llm_usage (agent, provider, created_at DESC);
