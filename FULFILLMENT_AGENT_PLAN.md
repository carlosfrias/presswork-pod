# Fulfillment Agent — Build Plan

## Context

The Fulfillment Agent is the fourth and final link in the Etsy/Printify pipeline (see `CLAUDE.md`). Unlike the prior three agents — which run on cron and process queue rows — Fulfillment is **event-driven**: an always-on Express webhook server that receives Etsy order webhooks, plus two cron jobs that handle a polling fallback (because Etsy webhooks are unreliable per CLAUDE.md) and tracking-number updates. It reads `listings`/`design_packages` to map an Etsy receipt to a Printify product, places the Printify order, persists the row in `orders`, polls Printify for the tracking number, and PATCHes that tracking back onto Etsy. The first three agents produce *listings*; this one produces *revenue and customer outcomes*. Failures here cost real money, so error handling is louder (immediate Slack alerts) and idempotency is mandatory.

This is the **second TypeScript agent**. The TypeScript monorepo bootstrap was completed by the Listing plan (root `package.json`, `tsconfig.base.json`, `packages/shared/` with `config/db/logger/types/etsy-tokens`). This plan builds on that foundation and does NOT need to repeat it. However, two pieces of TS infrastructure planned for `packages/listing/src/` — `etsy-auth.ts` and `etsy-api.ts` — are cross-cutting between Listing and Fulfillment and are therefore promoted to `packages/shared/` as part of this plan. If Listing has built them locally by the time Fulfillment starts, step 3 moves them and rewrites Listing's imports; otherwise step 3 builds them fresh in shared (the Listing plan's steps 20–22 are then satisfied by these shared modules).

Per decisions made before planning:

- **Scope (v1):** initial order placement + tracking sync + the receipt-polling fallback. Etsy cancellations/refunds, partial shipments, address corrections, and order edits are a later plan.
- **Webhook framework:** Express per CLAUDE.md ("TypeScript Express server"). JSON middleware everywhere except `/webhook/etsy-order`, which uses `express.raw()` so HMAC verification has access to the exact bytes Etsy signed.
- **HMAC scheme:** HMAC-SHA256 using `ETSY_API_SECRET`. The exact header name and signed-payload format (e.g., `${timestamp}.${rawBody}`) must be confirmed against current Etsy webhook docs in step 9 — Etsy's webhook signing scheme is documented and stable enough to encode now, but the implementation step double-checks. Replay window: 5 minutes per CLAUDE.md "Webhook HMAC verification" → "Replay attacks (old timestamp) rejected".
- **Idempotency:** enforced at the database via the `UNIQUE` constraint on `orders.etsy_order_id` already specified in CLAUDE.md. Code path is `INSERT ... ON CONFLICT DO NOTHING RETURNING *` — if zero rows returned, the order already exists; skip and return 200. **The webhook handler and the receipt poller share this exact path** so they can't fight.
- **Receipt vs. order terminology:** Etsy's API uses "receipts"; our schema column is `etsy_order_id` (per CLAUDE.md). Internally the value stored there IS the Etsy `receipt_id`. The schema name is preserved for compatibility; comments in code clarify.
- **Receipt enrichment:** webhook payload alone is not trusted — every order pipeline run does `GET /application/shops/{shop_id}/receipts/{receipt_id}` to fetch the canonical receipt (buyer address, line items, shipping address, sale price). The webhook is just a "wake up" signal.
- **Polling fallback:** cron every 5 minutes hits `GET /application/shops/{shop_id}/receipts?was_paid=true&was_shipped=false` (per CLAUDE.md "Critical Etsy webhook caveat") and pipes any receipts not already in our `orders` table into the same processor the webhook uses. Identical idempotency path means duplicates are silently dropped.
- **Tracking poller:** cron every 30 minutes selects `orders WHERE status='submitted' AND printify_order_id IS NOT NULL`, calls Printify's `GET /v1/shops/{shop}/orders/{id}.json`, and on shipment promotes the row to `'shipped'` and PATCHes the Etsy receipt with tracking via `POST /application/shops/{shop_id}/receipts/{receipt_id}/tracking`.
- **Railway services:** 3 separate services sharing the same package code. The web service runs `server-entry.ts`; cron services run `poll-receipts-entry.ts` and `poll-tracking-entry.ts`. All three share the `@presswork/shared` env var group. Registration in `infra/railway.toml` happens in step 29, after manual end-to-end verification.
- **Notifier:** Slack webhook + Resend email lives in `packages/shared/src/notifier.ts` so future agents (and Listing's failure paths) can reuse it. v1 fires Slack on every `orders.status='error'`; daily digest emails are deferred.
- **Margin tracking:** `orders.etsy_fees_usd` is computed from `sale_price_usd` using CLAUDE.md "Estimated Per-Unit Economics" formula (6.5% transaction + 3% processing + $0.25 + $0.20 listing). `orders.margin_usd` is the GENERATED column already specified in the CLAUDE.md schema — Postgres computes it; we only need to populate `etsy_fees_usd`, `print_cost_usd`, and `sale_price_usd`.
- **Print-cost lookup:** v1 reads a per-blueprint flat constant (Gildan 64000 = $8.50 per CLAUDE.md). A real Printify catalog cost lookup is a later plan, mirroring the same simplification the Listing agent's pricing module makes.
- **Schedule:** cron services not registered with Railway in v1. Manual triggering via `npm run start --workspace=packages/fulfillment` (server) and `npm run poll-receipts --workspace=packages/fulfillment` / `npm run poll-tracking --workspace=packages/fulfillment` (cron entries). Railway service registration is a step in Phase M after end-to-end manual verification.

The plan is broken into 30 sequential steps grouped into 13 phases. Each step is small enough for one focused Sonnet pass.

---

## Phase A — Database

### Step 1: Migration `infra/supabase/migrations/004_orders.sql`
Create the migration with:
- The `orders` table verbatim from CLAUDE.md "Database Schema" section, including the `margin_usd` GENERATED column and `UNIQUE` constraint on `etsy_order_id`
- `CREATE INDEX idx_orders_status ON orders(status);`
- `CREATE INDEX idx_orders_printify_id ON orders(printify_order_id);` (for the tracking poller's `WHERE status='submitted' AND printify_order_id IS NOT NULL` selection)
- `CREATE TRIGGER trg_orders_updated ...` (reuses `update_timestamp()` from migration 001 — do NOT redefine)
- **No** `claim_pending_*` RPC. The orders flow uses `UNIQUE` constraint + `INSERT ... ON CONFLICT DO NOTHING` for idempotency; the tracking poller reads-then-updates without needing atomic claim semantics. Document this deviation from the listing/scout pattern in a one-line SQL comment so a future reader knows it's intentional.

### Step 2: Apply migration to cloud Supabase
- `supabase db push` (pushes to the linked cloud project)
- Verify via Supabase dashboard (Table Editor) or `supabase inspect db schema --linked`: `orders` table exists with all columns, `margin_usd` shows as a generated column, both indexes present, trigger fires on update.

---

## Phase B — Shared TypeScript additions

### Step 3: Promote (or build) `packages/shared/src/etsy-auth.ts`
Owns the OAuth refresh flow. **If `packages/listing/src/etsy-auth.ts` already exists from the Listing plan's step 20, move it here and update the listing's imports; otherwise build per the Listing plan's step 20 directly in shared:**
- `getValidAccessToken(db: Db): Promise<string>` — reads `getEtsyTokens(db)` from the existing `etsy-tokens.ts`. If `expiresAt` > 60s in future, return as-is. Else POST `https://api.etsy.com/v3/public/oauth/token` with `grant_type=refresh_token`, `client_id={ETSY_API_KEY}`, `refresh_token={current refresh}`. Persist via `setEtsyTokens(db, ...)`. Return the new access token.
- Throws typed `EtsyAuthError` on refresh failure.
- Re-export from `packages/shared/src/index.ts`.

### Step 4: Promote (or build) `packages/shared/src/etsy-api.ts`
Generic Etsy v3 client. Same shape as Listing plan step 21, but expanded with the wrappers Fulfillment needs:
- Singleton Bottleneck (`new Bottleneck({ maxConcurrent: 1, minTime: 100 })` → 10 req/sec) at module scope so listings, receipts, and tracking all share the cap (per CLAUDE.md "Etsy rate limits")
- `async-retry`: 3 attempts, exp backoff, retry only 5xx + 429
- `etsyFetch(db, path, init)` helper that auto-refreshes auth via `getValidAccessToken`, adds `Authorization: Bearer ${token}` + `x-api-key: ${ETSY_API_KEY}`, threads through Bottleneck/retry, parses JSON, throws on non-2xx with the Etsy error body included
- Wrappers needed by Fulfillment: `getReceipt(db, receiptId)`, `listReceipts(db, params)`, `submitTracking(db, receiptId, { tracking_code, carrier_name, send_bcc? })`
- Wrappers already needed by Listing (move from `packages/listing/src/etsy-api.ts` if it exists): `createDraftListing`, `uploadListingImage`, `activateListing`
- Each wrapper Zod-validates its response (no `any` per CLAUDE.md TypeScript rules)
- If the move happens, also update `packages/listing/src/publisher.ts` imports to point at `@presswork/shared` and delete the listing-local copy

### Step 5: `packages/shared/src/notifier.ts`
- `notifySlack(message: string, opts?: { severity: 'info' | 'warn' | 'error' }): Promise<void>` — POSTs to `SLACK_WEBHOOK_URL` with `{ text }`. No-op (single warn log) if env var unset, so dev runs don't crash.
- `notifyEmail(subject: string, body: string): Promise<void>` — uses Resend SDK with `RESEND_API_KEY` to `ALERT_EMAIL`. Same no-op behavior if unset.
- **Throws nothing.** Alerts must not break the calling pipeline. Errors are caught and logged at `warn`.
- Re-export from `packages/shared/src/index.ts`.

### Step 6: Tests for shared additions
- `etsy-auth.test.ts`, `etsy-api.test.ts`, `notifier.test.ts` — all unit tests using Vitest + MSW. Confirm:
  - `etsy-auth`: happy path returns cached token; near-expiry triggers refresh-endpoint call and persistence; expired refresh token → `EtsyAuthError`
  - `etsy-api`: 429 retried 3x, 401 triggers refresh and one retry of original request, 4xx (non-401/429) bubbles immediately
  - `notifier`: missing env vars → no throw, single log line; mocked Slack call returns 200; Resend SDK call succeeds with the right `to` and `subject`

---

## Phase C — Fulfillment package skeleton

### Step 7: `packages/fulfillment/` skeleton
Create:
- `packages/fulfillment/package.json` — name `@presswork/fulfillment`, type `"module"`, scripts:
  - `"build": "tsc -b"`
  - `"start": "node --import tsx/esm src/server-entry.ts"` (web service)
  - `"poll-receipts": "node --import tsx/esm src/poll-receipts-entry.ts"` (cron)
  - `"poll-tracking": "node --import tsx/esm src/poll-tracking-entry.ts"` (cron)
  - `"test": "vitest run"`
- Dependencies: `@presswork/shared` (workspace), `express@4`, `zod`, `async-retry`, `bottleneck`, `resend`. Dev: `vitest`, `msw@2`, `supertest`, `@types/express`, `@types/supertest`, `@types/node`.
- `packages/fulfillment/tsconfig.json` — extends root base, references `../shared`
- `packages/fulfillment/vitest.config.ts` — node environment, MSW setup file
- `packages/fulfillment/src/` — empty for now
- `packages/fulfillment/README.md` — placeholder, filled in step 30

### Step 8: `packages/fulfillment/src/constants.ts`
Module-level constants for v1:
- `RECEIPT_POLL_INTERVAL_MS = 5 * 60 * 1000` and `TRACKING_POLL_INTERVAL_MS = 30 * 60 * 1000` (per CLAUDE.md cadences; these are documentary — Railway cron schedules are the actual triggers)
- `WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300` — 5-minute replay window
- `MAX_RETRIES = 3` (matches CLAUDE.md "Error Handling & Retries")
- `BLUEPRINT_PRINT_COST_USD: Record<number, number> = { 6: 8.50 }` — flat per-blueprint print cost lookup, Gildan 64000 = blueprint id 6 = $8.50 per CLAUDE.md "Estimated Per-Unit Economics". One-line comment with date checked.
- `ETSY_FEE_TRANSACTION_PCT = 0.065`, `ETSY_FEE_PROCESSING_PCT = 0.03`, `ETSY_FEE_PROCESSING_FIXED_USD = 0.25`, `ETSY_FEE_LISTING_USD = 0.20`

---

## Phase D — Webhook signature verification

### Step 9: `packages/fulfillment/src/webhook-verify.ts`
A pure function for HMAC verification. Lives separately so `server.ts` stays small and the verifier is unit-testable in isolation.
- `export function verifyEtsyWebhook(rawBody: Buffer, signatureHeader: string | undefined, timestampHeader: string | undefined, secret: string): { valid: boolean; reason?: 'missing_signature' | 'replay' | 'mismatch' }`
- Returns `{ valid: false, reason: 'missing_signature' }` if signature header absent
- Returns `{ valid: false, reason: 'replay' }` if `Math.abs(now - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SEC`
- Computes HMAC-SHA256 of the canonical string Etsy signs (confirm exact format against current Etsy webhook docs during implementation; encode the format we expect now and update if docs differ) with `secret`, then `crypto.timingSafeEqual` against the supplied signature
- Returns `{ valid: false, reason: 'mismatch' }` on mismatch, `{ valid: true }` on match
- **No throws.** Caller decides HTTP status from the reason.

### Step 10: `packages/fulfillment/src/webhook-verify.test.ts`
Unit tests:
- Valid signature passes
- Missing signature → `'missing_signature'`
- Tampered body → `'mismatch'`
- Old timestamp (> 5 min) → `'replay'`
- Constant-time compare exercised by spying on `crypto.timingSafeEqual`
- Tests use synthetic request bodies and pre-computed HMAC pairs (no MSW needed)

---

## Phase E — Order processor (the orchestrator)

### Step 11: `packages/fulfillment/src/order-processor.ts`
The unit-testable core. Both the webhook handler and the receipt poller call into this. Mirrors the Listing agent's `publishOne` shape from `packages/listing/src/publisher.ts`.
- `export async function processOrder(db: Db, etsyReceiptId: string): Promise<{ orderId?: string; outcome: 'created' | 'duplicate' | 'error'; error?: string }>`
- Steps:
  1. **Idempotency-safe insert:** `INSERT INTO orders (etsy_order_id, status) VALUES ($1, 'received') ON CONFLICT (etsy_order_id) DO NOTHING RETURNING id`. If no row returned → `outcome: 'duplicate'`. This collapses lookup-then-insert race windows into one statement.
  2. **Enrich:** `etsyApi.getReceipt(db, etsyReceiptId)` → buyer address, line items, sale price.
  3. **Resolve listing → design package:** for each line item, look up `listings WHERE etsy_listing_id = ${item.listing_id}` joined to `design_packages` to get `image_url`, `printify_blueprint_id`, `printify_variant_ids`. If listing not found in our DB, this is a real ops issue (Etsy buyer paid for a listing we don't track) — set `orders.status='error'`, write `error_message`, fire `notifySlack(severity='error')`, return `outcome: 'error'`. Do NOT throw.
  4. **Compute economics:** `etsy_fees_usd = computeEtsyFees(sale_price)` (step 21). `print_cost_usd = lookupPrintCost(blueprint_id)`. Write `sale_price_usd`, `etsy_fees_usd`, `print_cost_usd`, `buyer_country` onto the orders row. `margin_usd` is generated by Postgres.
  5. **Submit Printify order:** `printifyOrders.createOrder(...)` (step 13). Update `orders.printify_order_id`, `orders.status='submitted'`. Return `outcome: 'created'`.
  6. **Error path:** any exception in steps 2–5 is caught. Set `orders.status='error'`, write `error_message`, increment `retry_count`. If `retry_count >= MAX_RETRIES`, leave at `'error'` and fire `notifySlack(severity='error')`. Else flip status back to `'received'` for the next cron pass to retry (per CLAUDE.md "Error Handling & Retries").
- Logs every action per CLAUDE.md contract: `{ agent: "fulfillment", action, record_id, status, duration_ms, error? }`.

### Step 12: `packages/fulfillment/src/order-processor.test.ts`
MSW + Vitest unit tests:
- Happy path: Etsy receipt fetched, Printify order created, row ends at `'submitted'` with `printify_order_id` and economics columns populated
- Idempotency: second call with same `etsyReceiptId` returns `'duplicate'`; only one Printify call hit the mock
- Listing not in DB: row ends at `'error'`, descriptive `error_message`, Slack alert fired, function returns `'error'` (does not throw)
- Printify create-order 5xx: row ends at `'received'` with `retry_count=1`; no Slack alert (still under retry budget)
- Third Printify failure: row stays at `'error'` with `retry_count=3`; Slack alert fired

---

## Phase F — Printify orders client

### Step 13: `packages/fulfillment/src/printify-orders.ts`
Printify orders API wrapper. Lives next to (not inside) the Listing-owned `packages/listing/src/printify.ts` — that module owns *product* concerns; this one owns *order* concerns. Same retry pattern.
- `createOrder(input): Promise<{ printifyOrderId: string }>` — POST `https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/orders.json` with the body shape from CLAUDE.md "Printify order shape":
  - `label: 'etsy-${etsyReceiptId}'` (Printify's own idempotency hint)
  - `line_items: [{ blueprint_id, variant_id, print_areas: { front: { src: imageUrl } }, quantity }]`
  - `shipping_method: 1`, `address_to: {...}` from receipt
- `getOrder(printifyOrderId): Promise<{ status: string; tracking?: { number: string; url: string; carrier: string } }>` — GET `/v1/shops/${shop}/orders/${id}.json`. Used by the tracking poller.
- 5xx retried (`async-retry`, 3 attempts, exp backoff); 4xx surfaces immediately with the Printify error body in the thrown message.
- Bottleneck: separate Printify limiter (`maxConcurrent: 1, minTime: 200` → 5 req/sec; conservative vs. Printify's published 600/min).
- Bearer auth from `PRINTIFY_API_TOKEN`.
- All responses Zod-validated.

### Step 14: `packages/fulfillment/src/printify-orders.test.ts`
MSW unit tests:
- `createOrder` happy path: returns Printify order id
- `createOrder` 5xx: retried 3x then succeeds; assert exactly 3 retry attempts
- `createOrder` 4xx: surfaces immediately with body in error message
- `getOrder` happy path: `'in_production'` and `'shipped'` (with tracking) variants both parse cleanly

---

## Phase G — Express webhook server

### Step 15: `packages/fulfillment/src/server.ts`
Build but do NOT bootstrap — separation between `server.ts` exporting `createApp()` and `server-entry.ts` calling `app.listen()` is what makes the server testable via supertest.
- `export function createApp(deps: { db: Db; processOrder: (db: Db, receiptId: string) => Promise<...> }): Express`
- Middleware:
  - For `/webhook/etsy-order`: `express.raw({ type: '*/*' })` so `req.body` is a `Buffer` of the exact bytes for HMAC verification. The route handler converts to JSON itself.
  - JSON middleware everywhere else
- Routes:
  - `GET /healthz` — `{ ok: true }`. For Railway healthcheck.
  - `POST /webhook/etsy-order`:
    1. Read `X-Etsy-Signature` and `X-Etsy-Request-Timestamp` headers (exact names confirmed during implementation against current Etsy docs)
    2. `verifyEtsyWebhook(rawBody, sig, ts, ETSY_API_SECRET)`. If invalid → respond **401** with `{ error: reason }`. **CRITICAL:** 401 not 500 (per CLAUDE.md "Webhook HMAC verification" required test).
    3. Parse JSON from `rawBody.toString('utf8')`; extract `receipt_id` (Etsy's actual webhook payload schema confirmed during implementation; if Etsy uses a different field name like `id`, update accordingly).
    4. `await deps.processOrder(deps.db, receiptId)`. Result is `{ outcome: 'created' | 'duplicate' | 'error' }`.
    5. Always respond **200** (even on `'error'`) — Etsy retries failed webhooks aggressively, and our DB has the error row already; an Etsy retry would just bypass our internal retry budget. Log the error path explicitly.
- DI shape lets the test inject a stubbed `processOrder`.

### Step 16: `packages/fulfillment/src/server.test.ts`
Supertest tests against `createApp({ db: stub, processOrder: vi.fn() })`:
- Valid HMAC → 200, `processOrder` called once with extracted receipt id
- Invalid HMAC → 401, `processOrder` NOT called
- Missing signature header → 401
- Replay timestamp (> 5 min old) → 401
- Same receipt twice (where stubbed `processOrder` returns `'duplicate'` second time): both 200; one `'created'`, one `'duplicate'` outcome observed
- `processOrder` throws unexpectedly: still 200 returned, exception logged at `error`

---

## Phase H — Receipt polling fallback

### Step 17: `packages/fulfillment/src/receipt-poller.ts`
The safety net for unreliable Etsy webhooks (per CLAUDE.md "Critical Etsy webhook caveat").
- `export async function pollReceipts(db: Db, processOrder: typeof realProcessOrder = realProcessOrder): Promise<{ scanned: number; processed: number; skipped: number; errored: number }>`
- Steps:
  1. `etsyApi.listReceipts(db, { was_paid: true, was_shipped: false, limit: 100 })`
  2. For each receipt, `await processOrder(db, receipt.receipt_id)`. Idempotency in `processOrder` collapses already-known receipts.
  3. Aggregate outcomes; per-receipt failure does NOT stop processing of the rest (catch + log + continue).
- Uses the SAME `processOrder` as the webhook server. **This is the key architectural property:** the receipt poller and the webhook are two ingestion paths into one shared processor.

### Step 18: `packages/fulfillment/src/receipt-poller.test.ts`
MSW + Vitest:
- 3 receipts returned, 1 already in DB (stubbed `processOrder` returns `'duplicate'` for it) → result `{ scanned: 3, processed: 2, skipped: 1, errored: 0 }`
- Etsy `listReceipts` 5xx: retries via etsy-api, eventually surfaces error
- Empty receipt list → `{ scanned: 0, processed: 0, skipped: 0, errored: 0 }`, no throw
- One `processOrder` throws: rest still processed; counted as `errored: 1`

---

## Phase I — Tracking poller

### Step 19: `packages/fulfillment/src/tracking-poller.ts`
- `export async function pollTracking(db: Db): Promise<{ scanned: number; shipped: number; stillInProgress: number; errored: number }>`
- Steps:
  1. SELECT `id, printify_order_id, etsy_order_id` FROM `orders` WHERE `status = 'submitted'` AND `printify_order_id IS NOT NULL`
  2. For each row: `printifyOrders.getOrder(printifyOrderId)`
  3. Branch on Printify status:
     - `'in_production'` / `'submitted'` / `'on_hold'`: leave row alone; bump `stillInProgress`
     - `'fulfilled'` / `'shipped'` (verify exact Printify v1 strings during implementation): write `tracking_number`, `tracking_url` to `orders`, then `etsyApi.submitTracking(db, etsyReceiptId, { tracking_code, carrier_name })`. Set `status='shipped'`. Bump `shipped`.
     - `'cancelled'` / `'failed'`: log Slack alert; mark row `status='error'` with descriptive `error_message`. v1 does not auto-recover from Printify cancellation.
  4. On per-row failure (Etsy patch fails, Printify GET fails): leave row at `'submitted'` for next cron pass; increment `retry_count`; alert if `retry_count >= MAX_RETRIES`. Per-row failure does NOT stop the rest.

### Step 20: `packages/fulfillment/src/tracking-poller.test.ts`
MSW + Vitest:
- Happy path: 2 orders submitted, 1 shipped per Printify, 1 in production. After run: 1 row at `'shipped'` with tracking, 1 still at `'submitted'`. Etsy `submitTracking` called once with correct args.
- Etsy `submitTracking` 4xx: row stays at `'submitted'`, `error_message` set, `retry_count` incremented
- Printify says `'cancelled'`: row → `'error'`, Slack alert fired

---

## Phase J — Margin & utilities

### Step 21: `packages/fulfillment/src/economics.ts`
- `export function computeEtsyFees(saleUsd: number): number` — pure function returning `saleUsd * 0.065 + saleUsd * 0.03 + 0.25 + 0.20` (constants from `constants.ts`)
- `export function lookupPrintCost(blueprintId: number): number` — reads `BLUEPRINT_PRINT_COST_USD[blueprintId]`; throws `UnknownBlueprintError` if not found (defensive — alerts us when a new blueprint slips into the system without a cost entry)
- Pure functions. Trivially testable.

### Step 22: `packages/fulfillment/src/economics.test.ts`
- Canonical CLAUDE.md example: `$24.99 sale → ~$2.12 fees, ~$9.87 margin` (margin computed by Postgres in integration; here we just check the fee number matches)
- Boundary: $0 sale → $0.45 fees ($0.25 processing fixed + $0.20 listing). Sanity check the formula's intercepts.
- `lookupPrintCost(99999)` throws `UnknownBlueprintError`

---

## Phase K — Entry points

### Step 23: `packages/fulfillment/src/server-entry.ts`
The thin web-service bootstrap.
```ts
import { createApp } from './server.js';
import { getDb, getLogger } from '@presswork/shared';
import { processOrder } from './order-processor.js';

const log = getLogger("fulfillment");
const db = getDb();
const app = createApp({ db, processOrder });
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () =>
  log.info({ action: "server_start", port, status: "ready" })
);
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
```

### Step 24: `packages/fulfillment/src/poll-receipts-entry.ts`
The thin cron bootstrap. Run once and exit.
```ts
import { getDb, getLogger } from '@presswork/shared';
import { pollReceipts } from './receipt-poller.js';
import { processOrder } from './order-processor.js';

const log = getLogger("fulfillment");
const db = getDb();
pollReceipts(db, processOrder)
  .then((stats) => { log.info({ action: "receipt_poll_done", ...stats, status: "ok" }); process.exit(0); })
  .catch((e) => { log.error({ action: "receipt_poll_fail", error: String(e), status: "error" }); process.exit(1); });
```

### Step 25: `packages/fulfillment/src/poll-tracking-entry.ts`
Identical shape, calling `pollTracking(db)` instead.

---

## Phase L — Integration tests

### Step 26: `packages/fulfillment/tests/integration/webhook-flow.test.ts`
Gated by `INTEGRATION=1`. Connects to cloud Supabase via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Mocks Etsy + Printify at HTTP layer with MSW. (Same gating + cloud-only pattern as Listing's integration tests per Listing plan step 29.)
- Setup: insert 1 trend_brief + 1 design_package + 1 listing into cloud DB; remember the `etsy_listing_id`
- Mock Etsy `getReceipt(receiptId)` → returns a receipt referencing that `etsy_listing_id`, with buyer address and `sale_price_usd=24.99`
- Mock Printify `createOrder` → returns `{ id: "pf_test_001" }`
- Build a request body, sign it with HMAC, POST to a supertest instance of the Express app
- Assert: 200 response; one `orders` row with `status='submitted'`, `printify_order_id='pf_test_001'`, `etsy_fees_usd≈2.12`, `print_cost_usd=8.50`, `margin_usd≈14.37`
- Replay test: re-POST the same body. Assert: 200, still only one `orders` row.
- Bad signature test: POST with wrong HMAC. Assert: 401, no orders row inserted.
- Teardown: delete inserted listings/design_packages/trend_briefs/orders rows in `afterAll` (always runs, to avoid polluting cloud DB).

### Step 27: `packages/fulfillment/tests/integration/cron-flow.test.ts`
Gated by `INTEGRATION=1`.
- Setup: insert 1 listing + 2 orders (one `'submitted'` with `printify_order_id='pf_t1'`, one `'received'` to confirm the tracking poller doesn't touch wrong-status rows)
- Mock Etsy `listReceipts` → returns 2 receipts: one matching an existing orders row (skip), one new (process)
- Mock Printify `createOrder` for the new one → returns `{ id: "pf_t2" }`
- Run `pollReceipts(db)`: assert 1 new orders row at `'submitted'`, the existing one untouched
- Mock Printify `getOrder('pf_t1')` → `{ status: 'shipped', tracking: { number, url, carrier } }`
- Mock Etsy `submitTracking` → 200
- Run `pollTracking(db)`: assert orders row pf_t1 is now `'shipped'` with tracking; pf_t2 still `'submitted'`
- Teardown deletes everything in `afterAll`

---

## Phase M — Polish & verification

### Step 28: `.env.example` and CI updates
- `.env.example` already has `ETSY_API_SECRET`, `RESEND_API_KEY`, `ALERT_EMAIL`, `SLACK_WEBHOOK_URL`. Verify; add `PORT=3000` for the web server if missing.
- Add a `npm test --workspace=packages/fulfillment` step to `ci.yml` (per CLAUDE.md "Required jobs")
- Path filtering: `packages/fulfillment/**`, `packages/shared/**`, `infra/supabase/migrations/**` trigger this job (per CLAUDE.md "Path filtering")
- Integration tests run in `integration.yml` against cloud Supabase — same pattern as Listing's integration jobs (no local Docker container).

### Step 29: `infra/railway.toml` — register 3 services
- `fulfillment-server` — type web, command `npm run start --workspace=packages/fulfillment`, healthcheck path `/healthz`, port `$PORT`
- `fulfillment-cron-receipts` — type cron, schedule `*/5 * * * *`, command `npm run poll-receipts --workspace=packages/fulfillment`
- `fulfillment-cron-tracking` — type cron, schedule `*/30 * * * *`, command `npm run poll-tracking --workspace=packages/fulfillment`
- All three share the same env var group in Railway (per CLAUDE.md "Railway Deployment").
- **Hold off on registering services until step 30 manual verification passes.**

### Step 30: Fill in `packages/fulfillment/README.md` + end-to-end manual verification
README mirrors the Listing README structure (translated for an Express + cron setup):
- What fulfillment does (1 paragraph)
- Local setup, env vars, run commands (server, both crons)
- v1 scope notes: initial order placement + tracking only; no cancellation handling

End-to-end manual verification:
1. Confirm migrations 001–004 applied to cloud Supabase: `supabase migration list --linked`
2. Confirm a real `listings` row at `status='active'` with a real `etsy_listing_id` exists from the Listing agent's earlier run
3. Populate `.env` with real `ANTHROPIC_API_KEY`, `ETSY_*` (including `ETSY_API_SECRET`), `PRINTIFY_*`, `SUPABASE_*` (cloud), `SLACK_WEBHOOK_URL`, `RESEND_API_KEY`, `ALERT_EMAIL`
4. Run the server locally: `npm run start --workspace=packages/fulfillment`. In another terminal, replay a known-good signed webhook payload via curl against `localhost:3000/webhook/etsy-order`.
5. Verify via Supabase dashboard (orders table): one row with `status='submitted'`, `printify_order_id` set, `etsy_fees_usd`/`print_cost_usd`/`margin_usd` populated
6. Verify Printify dashboard: order exists, line items match
7. Trigger the receipt poller manually: `npm run poll-receipts --workspace=packages/fulfillment`. Verify it scans receipts and creates no duplicate row.
8. Wait for Printify to ship (or use Printify sandbox/test mode to simulate). Trigger the tracking cron manually: `npm run poll-tracking --workspace=packages/fulfillment`
9. Verify orders row → `status='shipped'`, `tracking_number`/`tracking_url` populated. Verify Etsy receipt has tracking attached (Etsy seller dashboard).
10. Failure-path manual test: temporarily break `ETSY_API_SECRET` to simulate HMAC failure; verify the webhook returns 401 (`curl -i` with a wrong-sig POST).
11. Slack: confirm an `error`-severity alert fires when a webhook references a listing not in our DB (set up by curling a webhook for a fake `listing_id`).
12. Once all manual checks pass, commit `infra/railway.toml` from step 29 and let Railway auto-deploy. Register the deployed `/webhook/etsy-order` URL in the Etsy seller dashboard's webhook configuration.

---

## Critical files to be created

| Path | Purpose |
|---|---|
| `infra/supabase/migrations/004_orders.sql` | DB schema for `orders` table + indexes |
| `packages/shared/src/etsy-auth.ts` | OAuth refresh flow (cross-cutting; built or moved here) |
| `packages/shared/src/etsy-api.ts` | Etsy v3 client (Bottleneck + retry; built or moved here) |
| `packages/shared/src/notifier.ts` | Slack + Resend alert helpers |
| `packages/fulfillment/package.json` | Manifest with 3 entry-point scripts |
| `packages/fulfillment/src/constants.ts` | Cron intervals, retry budget, fee constants, blueprint cost map |
| `packages/fulfillment/src/webhook-verify.ts` | HMAC-SHA256 + replay-window verification |
| `packages/fulfillment/src/order-processor.ts` | Orchestrator: receipt → listing lookup → Printify order |
| `packages/fulfillment/src/printify-orders.ts` | Printify orders API wrappers (`createOrder`, `getOrder`) |
| `packages/fulfillment/src/server.ts` | Express app factory (testable via supertest) |
| `packages/fulfillment/src/receipt-poller.ts` | Etsy webhook fallback poller |
| `packages/fulfillment/src/tracking-poller.ts` | Printify tracking poller + Etsy tracking submission |
| `packages/fulfillment/src/economics.ts` | Pure-function fee + print-cost lookup |
| `packages/fulfillment/src/server-entry.ts` | Web service bootstrap |
| `packages/fulfillment/src/poll-receipts-entry.ts` | Receipt cron bootstrap |
| `packages/fulfillment/src/poll-tracking-entry.ts` | Tracking cron bootstrap |
| `packages/fulfillment/README.md` | Setup and run docs |
| `infra/railway.toml` | 3 service definitions for Railway (created/extended in step 29) |

## Reused references

- `packages/shared/src/{config,db,logger,types,etsy-tokens}.ts` — already complete from the Listing plan; Fulfillment imports directly
- `packages/listing/src/printify.ts` — its retry/error pattern (`async-retry`, 5xx-only retries, Zod-validated responses) is the template for `printify-orders.ts`
- `packages/listing/src/publisher.ts` — its orchestrator-with-retry-budget shape is the template for `order-processor.ts`
- `claim_pending_design_package()` from migration 003 — the `FOR UPDATE SKIP LOCKED` pattern is **intentionally NOT used** here (orders use `INSERT ... ON CONFLICT DO NOTHING` for idempotency instead). Documented in step 1.
- `update_timestamp()` SQL function from migration 001 — reused; do NOT redefine
- The integration-test skeleton (gating, fixtures, teardown via direct DB calls, cloud-Supabase-not-local) is ported from Listing plan step 29 / `packages/scout/tests/integration/`

## Verification (end-to-end)

The plan is complete when step 30 succeeds: a real Etsy webhook lands on the deployed Railway server, HMAC verifies, the receipt is fetched, the corresponding `listings → design_packages` chain resolves, a Printify order is created, the orders row reaches `status='shipped'` with tracking, and the Etsy receipt shows the tracking number. Both cron services prove themselves in steps 7–8 of the manual verification (receipt fallback picks up a missed webhook in a dry run; tracking poller updates a shipped order). Idempotency is confirmed by the integration tests' replay assertions in step 26. All unit tests pass; integration tests pass under `INTEGRATION=1` (connecting to cloud Supabase). Failure-path retry behavior is verified by the failure-path assertions in steps 12, 16, 18, 20 of the unit tests.
