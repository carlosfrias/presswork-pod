# Printify API Compliance Plan

## Context

We integrate with Printify in two places: the listing pipeline (image upload + hidden product + mockup retrieval, in `packages/listing/src/printify.ts`) and the fulfillment pipeline (order creation + status polling, in `packages/fulfillment/src/printify-orders.ts`). A walk through Printify's official API docs (https://developers.printify.com) surfaced several places where we either violate documented requirements or rely on weaker patterns than what Printify recommends. None of these are catastrophic today, but each one increases the chance of throttling, account-level enforcement, or silent breakage as our request volume grows.

The goals of this plan are, in priority order:

1. Become compliant with Printify's stated header, rate-limit, and error-budget rules so we are not at risk of the "we reserve the right to enforce compliance" clause they call out.
2. Strengthen idempotency so we cannot accidentally double-charge a shop by re-submitting the same Etsy receipt.
3. Replace order-status polling with Printify's webhook system to cut request volume and tighten the loop on shipped → tracking-back-to-Etsy.
4. Consolidate our two duplicated Printify HTTP clients onto one shared, correctly-headered, rate-limited, 429-aware fetcher.

The plan is sequential. Each step is scoped so a single Sonnet session can complete it, including tests, with confidence. Do not skip ahead — later steps depend on the consolidated client built in Step 2.

Authoritative findings the plan is based on (verbatim where possible from Printify docs):

- **Required headers:** `Authorization: Bearer {token}`, `Content-Type: application/json;charset=utf-8`, and `User-Agent` (must be set to the client/app name — e.g. `presswork-listing/1.0`).
- **Rate limits:** 600 req/min global per integration; **200 product-publishing requests per 30 minutes**; 429 returned on overage.
- **Error budget:** "Requests resulting in an error response may not exceed 5% of your total requests." Account enforcement implied.
- **Idempotency:** Printify exposes an `external_id` field on order create. We currently piggyback on the human-readable `label` field, which is not the documented idempotency mechanism.
- **Webhooks:** Printify supports `order:updated`, `order:created`, `order:sent-to-production`, `order:shipment:created`, `order:shipment:delivered` (and similar) via `POST /v1/shops/{shop_id}/webhooks.json`. We currently use polling only (`packages/fulfillment/src/tracking-poller.ts`).

## Step-by-Step Plan

### Step 1 — Audit & document the current Printify surface area

**Goal:** A short tracking doc, `docs/printify-integration.md`, that lists every endpoint we call, the file:line, the per-endpoint rate-limit class (global / catalog / publishing), and the current error-handling behavior. No code changes.

**Files to read (no edits beyond the new doc):**

- `packages/listing/src/printify.ts`
- `packages/fulfillment/src/printify-orders.ts`
- `packages/fulfillment/src/tracking-poller.ts`
- `scripts/smoke_listing_printify.ts`
- `scripts/smoke_design_to_printify.py`
- All `*.test.ts` files that mock `api.printify.com`

**Deliverable:** A table mapping endpoint → method → call sites → rate-limit class. This becomes the reference for Step 2.

**Verification:** `grep -rn "api.printify.com" packages scripts | wc -l` and the doc's call-site list must match exactly.

---

### Step 2 — Build a shared `printifyFetch` in `packages/shared/src/printify-http.ts`

**Goal:** One HTTP client for all Printify calls, with correct headers, 429 handling, and a Bottleneck-based rate limiter. Replaces the two near-duplicate `printifyFetch` functions in `packages/listing/src/printify.ts:19-49` and `packages/fulfillment/src/printify-orders.ts:73-99`.

**New file:** `packages/shared/src/printify-http.ts`

**Requirements the shared client must satisfy:**

- Sets `Content-Type: application/json;charset=utf-8` (note the charset — current code omits it).
- Sets `User-Agent: presswork/<version>` from `package.json`. Read once at module load.
- Sets `Authorization: Bearer ${PRINTIFY_API_TOKEN}` from `getSettings()`.
- Wraps every request in a single Bottleneck limiter sized for the global limit: `maxConcurrent: 4, minTime: 110` (≈540 req/min, leaves headroom under the 600/min ceiling).
- A second, narrower limiter chained to the first, gated on a `class: "publishing"` opt-in for `POST /shops/.../products.json` and the visibility PUT — sized for the 200-per-30-min ceiling: `reservoir: 180, reservoirRefreshInterval: 30 * 60 * 1000, reservoirRefreshAmount: 180`.
- On HTTP `429`, parse `Retry-After` (seconds) and re-queue the request that many seconds later, retrying up to 3 times. Today both clients **bail immediately** on any 4xx — that is wrong for 429.
- On 5xx, keep current `async-retry` behavior (3 retries, exp backoff, factor 2, 500ms min).
- On 4xx other than 429, bail with `PrintifyError(status, body)` (current behavior, keep it).
- Export: `printifyFetch(path, init, opts?: { rateClass?: "global" | "publishing" }): Promise<unknown>` and `class PrintifyError`.

**Re-export from `packages/shared/src/index.ts`** so both downstream packages can import.

**Files updated (just to switch over the imports — no behavior change yet):**

- `packages/listing/src/printify.ts` — delete the local `printifyFetch`, import the shared one. Tag product-create and visibility-PUT with `rateClass: "publishing"`.
- `packages/fulfillment/src/printify-orders.ts` — delete the local `printifyFetch` and the local Bottleneck. Import the shared one. Order create and order GET use the default (global) rate class.

**Verification:**

- `npm test --workspace=packages/listing` and `npm test --workspace=packages/fulfillment` both pass. Existing tests already cover 5xx retry and 4xx bail; they should pass unchanged.
- New unit tests: `packages/shared/src/printify-http.test.ts` covering (a) User-Agent / Content-Type charset present, (b) 429 with Retry-After: 2 succeeds on second attempt, (c) 429 with no Retry-After uses default backoff, (d) 4xx non-429 still bails immediately.

---

### Step 3 — Add `external_id` to Printify orders for true idempotency

**Goal:** Defense-in-depth idempotency on the Printify side, in addition to our existing `orders.etsy_order_id UNIQUE` DB constraint.

**Files:**

- `packages/fulfillment/src/printify-orders.ts` — in `createOrder()` (around line 106), add `external_id: input.etsyReceiptId` to the request body. Keep the human-readable `label: \`etsy-${etsyReceiptId}\`` for the Printify dashboard.
- `packages/fulfillment/src/printify-orders.test.ts` — assert the request body now contains `external_id` and that re-submitting the same `etsyReceiptId` (which the caller in `order-processor.ts` already guards against via the DB) is exercised.

**Verification:**

- Unit test asserting `external_id` is in the POST body.
- Manual smoke test (against real Printify) is intentionally not in scope — Printify will reject duplicate `external_id` with a 4xx, which the existing 4xx-bail logic surfaces.

---

### Step 4 — Subscribe to Printify webhooks for order events

**Goal:** Replace 30-minute polling with sub-minute webhook-driven updates. Polling stays as a safety net (Printify webhooks are at-least-once but not guaranteed).

**New file:** `packages/fulfillment/src/printify-webhook.ts`

**Endpoint:** `POST /webhook/printify-order` mounted in `packages/fulfillment/src/index.ts` alongside the existing Etsy webhook.

**Subscription bootstrap:** Add a small idempotent registrar that on fulfillment service boot:

1. Calls `GET /v1/shops/{shop_id}/webhooks.json` to list current subscriptions.
2. If our `${PRINTIFY_WEBHOOK_BASE_URL}/webhook/printify-order` URL is not subscribed for `order:updated` and `order:shipment:created`, register it via `POST /v1/shops/{shop_id}/webhooks.json` with `{ topic, url, secret }`.
3. Store the returned webhook IDs in the existing `config` Supabase table for future cleanup.

**Signature verification:** HMAC-SHA256 of the raw request body using the per-webhook `secret` from the `config` table. Reject 401 on mismatch. Mirror the structure of the existing Etsy webhook HMAC verifier for consistency.

**Handler logic:**

1. Verify signature → 401 on failure.
2. Idempotency check: look up `orders` by `printify_order_id` from the payload. If `status` is unchanged, 200 OK no-op.
3. On `order:shipment:created`: extract tracking, update `orders` row, push tracking back to the Etsy receipt via existing helper.
4. On `order:updated`: update `orders.status` only.

**Env:**

- New env var `PRINTIFY_WEBHOOK_BASE_URL` (e.g. the Railway public URL).
- New env var `PRINTIFY_WEBHOOK_SECRET` (32-byte random string we generate, registered with Printify on first boot).
- Add both to `.env.example` and to the Zod config schema in `packages/shared/src/config.ts`.

**Polling stays.** `tracking-poller.ts` remains unchanged as a safety net but the cron interval can be relaxed from 30 min to 4 hours in a follow-up — out of scope for this step.

**Verification:**

- Unit test covering signature verification (valid, invalid, missing).
- Unit test for the idempotency no-op path.
- Local end-to-end: forward Printify webhooks via `ngrok`, fire a test event from Printify dashboard, observe DB update.

---

### Step 5 — Add an error-rate guard rail

**Goal:** Detect when our Printify error rate approaches the 5% ceiling Printify calls out, before they take action against the account.

**Files:**

- `packages/shared/src/printify-http.ts` — add an in-memory ring buffer of the last N=200 request outcomes (success / 4xx / 5xx). On every request, log `{ path, status, error_rate_5xx_pct, error_rate_4xx_pct }` at info level via the shared `pino` logger.
- `packages/shared/src/printify-metrics.ts` (small new file) — exports `getPrintifyErrorRate()` for use by an upcoming health endpoint.
- `packages/fulfillment/src/index.ts` — add `GET /healthz/printify` returning `{ ok: boolean, error_rate_4xx_pct, error_rate_5xx_pct, sample_size }`. `ok` is `false` if error rate ≥ 4% (one-percentage-point safety margin under Printify's 5% threshold).

**Why a ring buffer and not real Prometheus / OTel:** Scoped to one session, no new infra. Railway service logs already aggregate `pino` output, and the health endpoint is enough to wire to an external uptime monitor later.

**Verification:**

- Unit test for the ring buffer rate calculation at boundaries (0 samples, 1 error in 10, etc.).
- Hit `/healthz/printify` after the smoke test; confirm `ok: true` and `sample_size > 0`.

---

### Step 6 — Update CLAUDE.md and the smoke-test script

**Goal:** Documentation reflects new reality and the smoke test exercises the new client.

**Files:**

- `CLAUDE.md` — add a short subsection under "Agent 4 — Fulfillment" describing the webhook flow + polling fallback, and a new "Printify API Compliance" subsection summarizing Steps 1–5 and the error-budget rule. Keep edits minimal; do not rewrite existing prose.
- `scripts/smoke_listing_printify.ts` — switch to the shared client (already done by Step 2's import change, but verify) and add an assertion that the User-Agent header reaches Printify (can verify by intentionally setting an invalid one in a follow-up smoke run; in this script, just make sure it imports the shared client and runs end-to-end).
- `.env.example` — add `PRINTIFY_WEBHOOK_BASE_URL` and `PRINTIFY_WEBHOOK_SECRET`.

**Verification:**

- `npx ts-node scripts/smoke_listing_printify.ts` runs against cloud Supabase + real Printify and creates → cleans up a hidden product successfully.
- `git diff CLAUDE.md` shows only additions in the two intended sections.

---

## Files Touched, by Step

| Step | New files | Edited files |
|---|---|---|
| 1 | `docs/printify-integration.md` | — |
| 2 | `packages/shared/src/printify-http.ts`, `packages/shared/src/printify-http.test.ts` | `packages/shared/src/index.ts`, `packages/listing/src/printify.ts`, `packages/fulfillment/src/printify-orders.ts` |
| 3 | — | `packages/fulfillment/src/printify-orders.ts`, `packages/fulfillment/src/printify-orders.test.ts` |
| 4 | `packages/fulfillment/src/printify-webhook.ts`, `packages/fulfillment/src/printify-webhook.test.ts` | `packages/fulfillment/src/index.ts`, `packages/shared/src/config.ts`, `.env.example` |
| 5 | `packages/shared/src/printify-metrics.ts` | `packages/shared/src/printify-http.ts`, `packages/fulfillment/src/index.ts` |
| 6 | — | `CLAUDE.md`, `scripts/smoke_listing_printify.ts`, `.env.example` |

## End-to-End Verification After All Steps

1. `npm test --workspaces` — all unit tests pass.
2. `INTEGRATION=1 npm test --workspaces` — integration tests pass against local Supabase.
3. `npx ts-node scripts/smoke_listing_printify.ts` — creates a hidden Printify product end-to-end, mockup URLs return, product is cleaned up. Watch logs for the new `error_rate_*` fields.
4. Manually hit `GET /healthz/printify` on the running fulfillment service — returns `ok: true`.
5. Trigger a Printify test webhook from the Printify dashboard against the staging Railway URL — observe the `orders` row update and tracking propagation to the Etsy receipt.
6. Observe Printify dashboard's API usage panel — confirm requests carry our User-Agent string and that we sit comfortably under the 600/min and 200/30min ceilings.
