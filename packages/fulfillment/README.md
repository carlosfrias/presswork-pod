# @presswork/fulfillment

The fourth and final agent in the presswork pipeline. Receives Etsy order webhooks, places Printify orders, and syncs tracking back to Etsy.

## What it does

When an Etsy buyer pays for a listing, this agent:
1. Receives the webhook, verifies the HMAC-SHA256 signature, and extracts the receipt ID
2. Fetches the canonical receipt from Etsy (buyer address, line items, sale price)
3. Resolves the `listings → design_packages` chain to find the Printify blueprint and image URL
4. Computes economics (Etsy fees, print cost, margin) and writes them to the `orders` row
5. Creates a Printify order and updates `orders.status → submitted`
6. A cron job polls Printify for tracking numbers and patches the Etsy receipt when shipped

A second cron job (`poll-receipts`) polls `GET /receipts?was_paid=true&was_shipped=false` every 5 minutes as a fallback for missed webhooks.

## v1 scope

- Initial order placement + tracking sync
- Receipt-polling fallback for unreliable webhooks
- Immediate Slack alert on any `orders.status = 'error'`
- Not included: cancellations, refunds, partial shipments, address corrections

## Setup

Copy `.env.example` to `.env` and fill in all variables:

```
ETSY_API_KEY, ETSY_API_SECRET, ETSY_SHOP_ID, ETSY_ACCESS_TOKEN, ETSY_REFRESH_TOKEN
PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
SLACK_WEBHOOK_URL, RESEND_API_KEY, ALERT_EMAIL
PORT=3000
```

## Run

```bash
# Web server (always-on, receives webhooks)
npm run start --workspace=packages/fulfillment

# Receipt fallback cron (run every 5 min via Railway or manually)
npm run poll-receipts --workspace=packages/fulfillment

# Tracking sync cron (run every 30 min via Railway or manually)
npm run poll-tracking --workspace=packages/fulfillment
```

## Test

```bash
# Unit tests
npm test --workspace=packages/fulfillment

# Integration tests (requires cloud Supabase env vars)
INTEGRATION=1 npm test --workspace=packages/fulfillment
```

## Railway deployment

See `infra/railway.toml` for service definitions. Register after end-to-end manual verification passes (see FULFILLMENT_AGENT_PLAN.md step 30).
