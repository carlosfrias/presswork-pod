-- Insert a human review gate between every agent stage.
--
-- New status flow:
--   trend_briefs:    needs_review → approved → processing → done | error
--   design_packages: needs_review → approved → processing → done | error
--   listings:        (unchanged — already has needs_review)
--
-- Scout writes briefs at 'needs_review'. The dashboard's Approve action flips
-- them to 'approved'. The Design claim RPC below pulls 'approved' briefs.
-- Same pattern repeats for design_packages → listings.
--
-- No CHECK constraint exists on trend_briefs.status or design_packages.status,
-- so we don't need to alter constraints — we just start writing new values.

-- 1. Design claims briefs the user APPROVED, not freshly written ones.
CREATE OR REPLACE FUNCTION claim_pending_trend_brief()
RETURNS SETOF trend_briefs AS $$
  UPDATE trend_briefs
  SET status = 'processing'
  WHERE id = (
    SELECT id FROM trend_briefs
    WHERE status = 'approved'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$ LANGUAGE sql;

-- 2. Listing claims designs the user APPROVED, not Design's 'done' designs.
CREATE OR REPLACE FUNCTION claim_pending_design_package()
RETURNS SETOF design_packages AS $$
  UPDATE design_packages
  SET status = 'processing'
  WHERE id = (
    SELECT id FROM design_packages
    WHERE status = 'approved'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$ LANGUAGE sql;

-- 3. Backfill existing rows so they don't vanish from the new queues.
--    Old 'pending' briefs go into the new review queue. Old 'done' designs
--    pre-date the gate so we treat them as already-approved and ready for
--    Listing to claim.
UPDATE trend_briefs SET status = 'needs_review' WHERE status = 'pending';
UPDATE design_packages SET status = 'approved' WHERE status = 'done';

-- 4. Update the dashboard daily summary view to count both 'approved' and
--    'done' designs as "delivered" (either state means Design finished its work).
CREATE OR REPLACE VIEW dashboard_daily_summary AS
WITH days AS (
  SELECT generate_series(
    date_trunc('day', now() - interval '59 days'),
    date_trunc('day', now()),
    interval '1 day'
  )::date AS day
)
SELECT
  days.day,
  COALESCE(briefs.cnt, 0)                  AS briefs,
  COALESCE(designs.cnt, 0)                 AS designs,
  COALESCE(listings.cnt, 0)                AS listings_published,
  COALESCE(orders_agg.revenue_usd, 0)      AS revenue_usd,
  COALESCE(orders_agg.margin_usd, 0)       AS margin_usd,
  COALESCE(orders_agg.etsy_fees_usd, 0)    AS etsy_fees_usd,
  COALESCE(orders_agg.order_count, 0)      AS order_count,
  COALESCE(usage_fal.cost_usd, 0)          AS fal_spend_usd,
  COALESCE(usage_anthropic.cost_usd, 0)    AS anthropic_spend_usd
FROM days
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS cnt
  FROM trend_briefs GROUP BY 1
) briefs ON briefs.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS cnt
  FROM design_packages WHERE status IN ('approved', 'done', 'needs_review') GROUP BY 1
) designs ON designs.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS cnt
  FROM listings WHERE is_active = true GROUP BY 1
) listings ON listings.day = days.day
LEFT JOIN (
  SELECT
    date_trunc('day', created_at)::date AS day,
    COALESCE(SUM(sale_price_usd), 0)    AS revenue_usd,
    COALESCE(SUM(margin_usd), 0)        AS margin_usd,
    COALESCE(SUM(etsy_fees_usd), 0)     AS etsy_fees_usd,
    COUNT(*)                            AS order_count
  FROM orders WHERE status = 'logged' GROUP BY 1
) orders_agg ON orders_agg.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd
  FROM llm_usage WHERE provider = 'fal' GROUP BY 1
) usage_fal ON usage_fal.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd
  FROM llm_usage WHERE provider = 'anthropic' GROUP BY 1
) usage_anthropic ON usage_anthropic.day = days.day
ORDER BY days.day DESC;

-- 5. Seed the two bypass flags. Defaulting to false (review required) — flip
--    to true via the dashboard if you want to restore the old auto-flow.
INSERT INTO runtime_flags (key, value, description) VALUES
  ('scout_auto_approve_enabled',  'false', 'Skip review gate: Scout writes briefs directly as approved (auto-flow).'),
  ('design_auto_approve_enabled', 'false', 'Skip review gate: Design writes finished designs directly as approved (auto-flow).')
ON CONFLICT (key) DO NOTHING;
