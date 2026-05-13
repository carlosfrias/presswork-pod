# @presswork/ledger

The fourth agent in the presswork pipeline. Metrics and financial tracking only — fulfillment is handled by Etsy's native Printify integration, so this agent never touches Printify.

## What it does

A cron job polls the Etsy receipts API every 30 minutes for paid orders. For each new receipt it:

1. Computes economics: sale price (buyer currency + USD-normalized), Etsy fees, estimated print cost, derived margin.
2. Resolves `listings → design_packages` to look up the Printify blueprint and its flat print cost. If the listing isn't in our DB, the row still logs with `print_cost_usd = NULL`.
3. INSERTs into the `orders` table. Idempotency is enforced by the UNIQUE constraint on `etsy_order_id` — re-scanning the same window every tick is safe.
4. Fires a Slack warning when a single order's computed margin drops below `MARGIN_WARNING_THRESHOLD_USD`.

A second cron runs the daily digest: revenue, fees, print cost, and margin totals for the previous UTC day, posted to Slack and emailed via Resend.

## v1 scope

- Receipt polling + economics logging
- Per-order low-margin Slack alert
- Daily revenue + margin digest (Slack + email)
- Not included: webhook ingestion, Printify order creation, tracking sync, refund handling — all of that is Etsy/Printify's responsibility now.

## Setup

Copy `.env.example` to `.env` and fill in:

```
ETSY_API_KEY, ETSY_API_SECRET, ETSY_SHOP_ID, ETSY_ACCESS_TOKEN, ETSY_REFRESH_TOKEN
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
SLACK_WEBHOOK_URL, RESEND_API_KEY, ALERT_EMAIL
```

Note: `PRINTIFY_*` env vars are no longer used by this agent.

## Run

```bash
# Poll Etsy receipts (every 30 min via Railway)
npm run poll-receipts --workspace=packages/ledger

# Daily digest (once per day via Railway)
npm run daily-digest --workspace=packages/ledger
```

## Test

```bash
npm test --workspace=packages/ledger
```

## Railway deployment

See `infra/railway.toml` for service definitions.
