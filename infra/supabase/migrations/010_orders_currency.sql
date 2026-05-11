-- orders.currency_code + orders.sale_price: persist the buyer's actual currency
-- alongside the USD-normalized amount. Previously sale_price_usd = amount /
-- divisor stored EUR/GBP/etc. values mislabeled as USD, corrupting every
-- economics + pricing-floor report.
--
-- sale_price_usd remains the normalized value used by reporting. sale_price is
-- the raw buyer-paid amount in their currency. currency_code is ISO 4217.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS currency_code TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS sale_price NUMERIC;

-- Backfill: for existing rows where sale_price_usd is set, treat the historical
-- value as USD-equivalent (best-effort — pre-migration we had no way to know
-- the buyer's currency). New rows always set both.
UPDATE orders
SET sale_price = sale_price_usd
WHERE sale_price IS NULL AND sale_price_usd IS NOT NULL;
