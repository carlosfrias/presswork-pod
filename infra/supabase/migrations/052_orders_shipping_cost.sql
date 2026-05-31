-- Track the Printify fulfillment shipping cost the shop absorbs on every order
-- and fold it into margin. Previously margin_usd = sale - print - fees, which
-- overstated true margin by the (~$4.50) shipping we pay Printify regardless of
-- whether the buyer-facing Etsy profile is free or calculated.
--
-- A generated column's expression can't be altered in place, and the
-- dashboard_daily_summary view sums orders.margin_usd, so we: add the new
-- column, drop the view, drop+recreate margin_usd with the shipping term, then
-- recreate the view (definition unchanged — it just re-reads the corrected
-- margin_usd). Existing rows have shipping_cost_usd = NULL → COALESCE keeps
-- their margin unchanged; new rows get the real cost.

BEGIN;

ALTER TABLE orders ADD COLUMN shipping_cost_usd NUMERIC;

DROP VIEW IF EXISTS dashboard_daily_summary;

ALTER TABLE orders DROP COLUMN margin_usd;
ALTER TABLE orders ADD COLUMN margin_usd NUMERIC GENERATED ALWAYS AS (
  sale_price_usd
    - COALESCE(print_cost_usd, 0)
    - COALESCE(shipping_cost_usd, 0)
    - COALESCE(etsy_fees_usd, 0)
) STORED;

-- Recreated verbatim (current definition) so it picks up the new margin_usd.
CREATE VIEW dashboard_daily_summary AS
WITH days AS (
  SELECT generate_series(
    date_trunc('day', now() - interval '59 days'),
    date_trunc('day', now()),
    interval '1 day'
  )::date AS day
)
SELECT
  days.day,
  COALESCE(briefs.cnt, 0)               AS briefs,
  COALESCE(designs.cnt, 0)              AS designs,
  COALESCE(listings.cnt, 0)            AS listings_published,
  COALESCE(orders_agg.revenue_usd, 0)  AS revenue_usd,
  COALESCE(orders_agg.margin_usd, 0)   AS margin_usd,
  COALESCE(orders_agg.etsy_fees_usd, 0) AS etsy_fees_usd,
  COALESCE(orders_agg.order_count, 0)  AS order_count,
  COALESCE(usage_fal.cost_usd, 0)      AS fal_spend_usd,
  COALESCE(usage_anthropic.cost_usd, 0) AS anthropic_spend_usd
FROM days
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, count(*) AS cnt
  FROM trend_briefs GROUP BY 1
) briefs ON briefs.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, count(*) AS cnt
  FROM design_packages
  WHERE status = ANY (ARRAY['approved', 'done', 'needs_review'])
  GROUP BY 1
) designs ON designs.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, count(*) AS cnt
  FROM listings WHERE is_active = true GROUP BY 1
) listings ON listings.day = days.day
LEFT JOIN (
  SELECT
    date_trunc('day', created_at)::date AS day,
    COALESCE(sum(sale_price_usd), 0) AS revenue_usd,
    COALESCE(sum(margin_usd), 0)     AS margin_usd,
    COALESCE(sum(etsy_fees_usd), 0)  AS etsy_fees_usd,
    count(*)                         AS order_count
  FROM orders WHERE status = 'logged' GROUP BY 1
) orders_agg ON orders_agg.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COALESCE(sum(cost_usd), 0) AS cost_usd
  FROM llm_usage WHERE provider = 'fal' GROUP BY 1
) usage_fal ON usage_fal.day = days.day
LEFT JOIN (
  SELECT date_trunc('day', created_at)::date AS day, COALESCE(sum(cost_usd), 0) AS cost_usd
  FROM llm_usage WHERE provider = 'anthropic' GROUP BY 1
) usage_anthropic ON usage_anthropic.day = days.day
ORDER BY days.day DESC;

COMMIT;
