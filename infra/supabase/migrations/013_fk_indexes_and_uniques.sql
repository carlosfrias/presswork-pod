-- 1) Foreign-key indexes. Postgres does NOT auto-create indexes on FK columns;
--    without these every join against trend_briefs / design_packages / listings
--    falls back to a sequential scan, which gets ugly fast as volume grows.

CREATE INDEX IF NOT EXISTS idx_design_packages_trend_brief_id
  ON design_packages(trend_brief_id);

CREATE INDEX IF NOT EXISTS idx_listings_design_package_id
  ON listings(design_package_id);

CREATE INDEX IF NOT EXISTS idx_orders_listing_id
  ON orders(listing_id);

-- 2) Partial UNIQUE on orders.printify_order_id. printify_order_id is NULL
--    until we POST to Printify; the partial WHERE keeps NULLs out of the
--    constraint so the column can stay nullable.

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_printify_order_id
  ON orders(printify_order_id)
  WHERE printify_order_id IS NOT NULL;

-- 3) Partial UNIQUE on design_packages.trend_brief_id — one design per trend
--    brief. Before applying the index we collapse any pre-existing duplicates
--    by keeping the most recently-created design_packages row per trend_brief.
--    Rows referenced by listings are preserved; orphans (no listing) are
--    deleted. If both duplicates have listings, the older one is kept to avoid
--    breaking existing FK references.

WITH ranked AS (
  SELECT
    dp.id,
    dp.trend_brief_id,
    EXISTS (SELECT 1 FROM listings l WHERE l.design_package_id = dp.id) AS has_listing,
    ROW_NUMBER() OVER (
      PARTITION BY dp.trend_brief_id
      ORDER BY
        EXISTS (SELECT 1 FROM listings l WHERE l.design_package_id = dp.id) DESC,
        dp.created_at ASC
    ) AS rn
  FROM design_packages dp
  WHERE dp.trend_brief_id IS NOT NULL
)
DELETE FROM design_packages
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 1 AND has_listing = false
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_design_packages_trend_brief_id
  ON design_packages(trend_brief_id)
  WHERE trend_brief_id IS NOT NULL;
