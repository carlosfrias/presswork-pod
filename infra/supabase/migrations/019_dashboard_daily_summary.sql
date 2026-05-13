-- A regular SQL view that pre-rolls the per-day numbers the dashboard's
-- Overview chart needs. Row volumes here are tiny (one row per day per table),
-- so this is cheap to recompute and we skip materialization.
--
-- The series anchors on `generate_series` so days with zero activity still
-- show up (otherwise the chart would have gaps).

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
  FROM design_packages WHERE status = 'done' GROUP BY 1
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
