# Etsy Bug Fixes Plan

## Context

While writing the Etsy skill file (`.claude/skills/etsy/SKILL.md`) we surfaced four real bugs/gaps in the existing Etsy integration. Each will break against live Etsy, none are caught by current tests because everything is mocked at the wire. We need to fix all four before any real Etsy traffic.

The four issues:

1. **Webhook signature verifier is wrong scheme.** `packages/fulfillment/src/webhook-verify.ts` does plain HMAC-SHA256 (hex) of just the raw body using `X-Etsy-Signature`. Real Etsy webhooks use a Svix-style scheme: headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<b64sig>`; signed payload is `${id}.${ts}.${rawBody}`; secret is prefixed `whsec_` and the rest is base64. Current code will reject every real production webhook.
2. **`readiness_state_id` not sent on listing create.** As of Etsy's Sep 30 2025 Processing Profiles migration this field is required for physical listings. Real Etsy will silently reject our `createDraftListing` calls.
3. **Taxonomy ID hardcoded** as `ETSY_TAXONOMY_ID_TSHIRT = 68887043` in `packages/listing/src/constants.ts:2`. The accompanying TODO says "verify via `GET /application/seller-taxonomy/nodes` once Etsy API access is live". User chose dynamic lookup over verify-only.
4. **No carrier-name normalization.** Carrier strings flow raw from Printify ("USPS", "FedEx") into `submitTracking()` (`packages/shared/src/etsy-api.ts:101-111`). Etsy accepts the API call but tracking never delivers to the buyer when the carrier name doesn't match its accepted enum.

The plan is sequential — each step is narrow enough to complete confidently in one Sonnet session including tests. The final step updates the etsy skill file to remove warnings that are no longer accurate.

---

## Step 1 — Replace Etsy webhook signature verification with Svix-style scheme

**Goal:** The verifier accepts real Etsy webhook signatures.

**Files:**
- `packages/shared/src/config.ts` — add `ETSY_WEBHOOK_SECRET: z.string().min(1).optional()` (Etsy gives this when the webhook subscription is created; format is `whsec_<base64>`).
- `packages/fulfillment/src/webhook-verify.ts` — rewrite `verifyEtsyWebhook`. New signature:
  ```ts
  verifyEtsyWebhook(
    rawBody: Buffer,
    headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
    secret: string | undefined
  ): WebhookVerifyResult
  ```
  Logic:
  1. Bail with `missing_secret` if `secret` is undefined.
  2. Bail with `missing_signature` if any of id/timestamp/signature header is missing.
  3. Replay check: still gates on `WEBHOOK_TIMESTAMP_TOLERANCE_SEC` (5 min) using the new `webhook-timestamp` header.
  4. Strip `whsec_` prefix from the secret, then base64-decode the remainder → `decodedSecret`.
  5. Build signed payload string: `${id}.${timestamp}.${rawBody.toString("utf8")}`.
  6. Compute `base64(HMAC_SHA256(decodedSecret, signedPayload))`.
  7. The `webhook-signature` header may contain space-separated `v1,<b64sig>` entries (Svix supports key rotation). Split, strip `v1,` prefixes, timing-safe-compare each against our computed sig — accept if any match.
  8. Result type extended: `valid: false; reason: "missing_secret" | "missing_signature" | "replay" | "mismatch"`.
- `packages/fulfillment/src/server.ts:42-54` — update the `/webhook/etsy-order` handler:
  - Read `webhook-id`, `webhook-timestamp`, `webhook-signature` headers (NOT `x-etsy-signature` / `x-etsy-request-timestamp`).
  - Pass `getSettings().ETSY_WEBHOOK_SECRET` (not `ETSY_API_SECRET`) to the verifier.
- `packages/fulfillment/src/webhook-verify.test.ts` — full rewrite of all 9 tests against the new scheme. Helper:
  ```ts
  function svixSign(secret: string, id: string, ts: string, body: Buffer): string {
    const decoded = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", decoded).update(`${id}.${ts}.${body.toString("utf8")}`).digest("base64");
    return `v1,${sig}`;
  }
  ```
  Test cases: valid sig accepted, valid sig with `whsec_` prefix on secret, valid sig in space-separated multi-sig header, missing sig → `missing_signature`, wrong sig → `mismatch`, replay (>5 min) → `replay`, missing secret → `missing_secret`, tampered body → `mismatch`, length-mismatch buffer guard.
- `packages/fulfillment/src/server.test.ts` — update the `signPayload` and request-construction helpers to emit Svix-style headers.
- `.env.example` — add `ETSY_WEBHOOK_SECRET=` with a `# Provided by Etsy when you create the webhook subscription. Format: whsec_<base64>` comment.

**Verification:**
- `npm test --workspace=packages/fulfillment` passes.
- All 9 webhook-verify tests + the server webhook tests use the new scheme.
- Existing `ETSY_API_SECRET` env var stays (still used elsewhere — don't remove).

---

## Step 2 — Add `readiness_state_id` to listing creation

**Goal:** Listing creates carry the field Etsy now requires for physical listings.

**Files:**
- `packages/shared/src/config.ts` — add `ETSY_READINESS_STATE_ID: z.coerce.number().int().positive()` (required, mirrors `ETSY_SHIPPING_PROFILE_ID`).
- `packages/shared/src/etsy-api.ts:115-132` — add `readiness_state_id: z.number().int().positive()` to `EtsyListingCreateInputSchema` (required, not optional — coupled to the env var).
- `packages/listing/src/publisher.ts:184-195` — pass `readiness_state_id: ETSY_READINESS_STATE_ID` into the `createDraftListing` call.
- `scripts/get_etsy_readiness_state.ts` (new, parallel to `scripts/get_etsy_tokens.py`) — one-time bootstrap. Reads tokens from cloud Supabase via `getValidAccessToken`, calls `GET /application/shops/{shop_id}/readiness-state-definitions` to list existing definitions, prints them. If none exist, calls `POST /application/shops/{shop_id}/readiness-state-definitions` with sensible defaults (1-3 business day processing) and prints the new ID. The user copies the ID into `ETSY_READINESS_STATE_ID` in env.
- `.env.example` — add `ETSY_READINESS_STATE_ID=` with a comment pointing at the bootstrap script.
- Test fixtures (every `validEnv` block in test files) — add `ETSY_READINESS_STATE_ID: "1"`. Affected files (search for `ETSY_SHIPPING_PROFILE_ID` to find all): `packages/shared/tests/config.test.ts`, `packages/listing/src/printify.test.ts`, `packages/listing/src/publisher.test.ts`, `packages/fulfillment/src/printify-orders.test.ts`, `packages/fulfillment/src/printify-webhook.test.ts`, `packages/fulfillment/src/server.test.ts`, `packages/listing/tests/integration/publisher-flow.test.ts`, etc.
- `packages/listing/src/publisher.test.ts` — add an assertion that `createDraftListing` body includes `readiness_state_id`.

**Verification:**
- `npm run build --workspace=packages/shared` then `npm run typecheck` clean.
- `npm test --workspaces` passes (all `validEnv` blocks updated).
- Schema parse test: missing `readiness_state_id` → Zod rejects.

---

## Step 3 — Normalize `carrier_name` before submitting to Etsy

**Goal:** Carrier names sent to Etsy match its accepted enum, so tracking actually delivers to buyers.

**Files:**
- `packages/shared/src/constants.ts` — add:
  - `ETSY_CARRIER_NAMES: ReadonlySet<string>` — known Etsy carrier strings (`usps`, `ups`, `fedex`, `dhl`, `dhl-express`, `royal-mail`, `canada-post`, `australia-post`, `4px`, etc. — sourced from Etsy's documented carrier list).
  - `normalizeEtsyCarrierName(raw: string | undefined): string | null` — lowercases, strips spaces/punctuation, maps common variants ("USPS" → "usps", "FedEx" → "fedex", "DHL Express" → "dhl-express"). Returns the canonical string if it matches a known carrier; `null` if unknown.
- `packages/fulfillment/src/tracking-poller.ts:55-58` — call normalize first:
  ```ts
  const normalized = normalizeEtsyCarrierName(detail.tracking.carrier);
  if (!normalized) {
    log.warn({ ..., raw_carrier: detail.tracking.carrier });
    // Still mark shipped in DB so we don't poll forever; log alert so a human can manually push tracking.
    await notifySlack(`Unknown carrier "${detail.tracking.carrier}" for order ${order.id} — tracking NOT submitted to Etsy`, { severity: "warn" });
  } else {
    await submitTracking(db, order.etsy_order_id, { tracking_code: detail.tracking.number, carrier_name: normalized });
  }
  ```
- `packages/fulfillment/src/printify-webhook.ts:130-140` — same pattern around the `submitTracking()` call there.
- `packages/shared/src/constants.test.ts` (new, or extend existing) — unit tests for `normalizeEtsyCarrierName`: USPS variants, FedEx variants, DHL with/without "Express", whitespace, empty/undefined → null, unknown → null.
- `packages/fulfillment/src/tracking-poller.test.ts` — add a test for the unknown-carrier branch (no Etsy submit, Slack alert fired, status still marked shipped).

**Verification:**
- `npm test --workspaces` passes.

---

## Step 4 — Dynamic `taxonomy_id` lookup with caching

**Goal:** Replace the hardcoded T-shirt taxonomy ID with a live lookup against Etsy, cached in the Supabase `config` table for reuse.

**Files:**
- `packages/shared/src/etsy-taxonomy.ts` (new) — exports:
  ```ts
  type ProductKey = "tshirt";
  const PRODUCT_TAXONOMY_LABELS: Record<ProductKey, string[]> = {
    tshirt: ["T-Shirts"], // path from root or known leaf name; refine after first live lookup
  };
  export async function getTaxonomyId(db: Db, productKey: ProductKey): Promise<number>;
  ```
  Logic:
  1. Read `config` row keyed `etsy_taxonomy_${productKey}` → if present and parses as int, return it.
  2. Otherwise call `etsyFetch(db, "/application/seller-taxonomy/nodes")` → response is a tree of nodes with `id`, `name`, `children`.
  3. Walk depth-first, find the leaf whose `name` matches the configured label list for this product key (case-insensitive). Throw if not found.
  4. Upsert `{ key: "etsy_taxonomy_${productKey}", value: String(id) }` into `config`.
  5. Return the id.
- `packages/listing/src/publisher.ts:185` — replace `taxonomy_id: ETSY_TAXONOMY_ID_TSHIRT` with `taxonomy_id: await getTaxonomyId(db, "tshirt")`.
- `packages/listing/src/constants.ts` — remove `ETSY_TAXONOMY_ID_TSHIRT` constant and its TODO. Keep `MAX_ETSY_REQ_PER_SEC` etc.
- `packages/shared/src/index.ts` — export from `./etsy-taxonomy.js`.
- `packages/shared/src/etsy-taxonomy.test.ts` (new) — tests: cached path returns cached id without HTTP call; cache miss fetches and persists; tree walk finds nested leaf; missing node throws clear error.
- `packages/listing/src/publisher.test.ts` and the publisher integration test — update MSW handlers: add a mock for `GET /application/seller-taxonomy/nodes` returning a minimal tree containing a "T-Shirts" leaf. Pre-seed the `config` row in integration tests to skip the fetch where appropriate.

**Verification:**
- `npm test --workspaces` passes.
- Manual smoke (when Etsy creds are live): boot fulfillment, publish one listing, observe a single `GET /seller-taxonomy/nodes` call followed by the cached value being used on subsequent publishes.

---

## Step 5 — Update the etsy skill file to reflect the fixed state

**Goal:** Remove the now-stale "Known fragile spots" warnings and document the new patterns so future sessions don't re-fix what's already done.

**Files:**
- `.claude/skills/etsy/SKILL.md` — edits:
  - Delete the four "Known fragile spots" entries. The whole section becomes a one-line note: "All four originally documented bugs (webhook scheme, readiness_state_id, taxonomy lookup, carrier normalization) were fixed in `PLAN_ETSY_BUG_FIXES.md`." OR delete the section entirely.
  - **Webhook section:** rewrite to describe the Svix scheme as the actual current behavior. Mention `ETSY_WEBHOOK_SECRET` env var, `whsec_` prefix handling, and the helper signature.
  - **Listing create — required fields section:** add `readiness_state_id` to the "always" list. Reference `ETSY_READINESS_STATE_ID` env var and the `scripts/get_etsy_readiness_state.ts` bootstrap.
  - **New section "Taxonomy lookup":** point at `getTaxonomyId(db, productKey)` from `@presswork/shared`. Note caching in `config` table. Mention how to add a new product type (extend `PRODUCT_TAXONOMY_LABELS`).
  - **Tracking submission section:** add a paragraph about `normalizeEtsyCarrierName()` from `@presswork/shared` — required before any `submitTracking` call. Unknown carriers are logged + Slack-alerted, NOT submitted.
  - Update **endpoint inventory table** to include `GET /application/seller-taxonomy/nodes` and `GET/POST /application/shops/{id}/readiness-state-definitions`.
  - Update **env vars** section: add `ETSY_WEBHOOK_SECRET` and `ETSY_READINESS_STATE_ID`.

**Verification:**
- `wc -l .claude/skills/etsy/SKILL.md` still under 200 lines.
- Manual read: no remaining warnings about issues that Steps 1-4 fixed; new patterns are discoverable.

---

## Files Touched, by Step

| Step | New files | Edited files |
|---|---|---|
| 1 | — | `packages/shared/src/config.ts`, `packages/fulfillment/src/webhook-verify.ts`, `packages/fulfillment/src/webhook-verify.test.ts`, `packages/fulfillment/src/server.ts`, `packages/fulfillment/src/server.test.ts`, `.env.example` |
| 2 | `scripts/get_etsy_readiness_state.ts` | `packages/shared/src/config.ts`, `packages/shared/src/etsy-api.ts`, `packages/listing/src/publisher.ts`, `packages/listing/src/publisher.test.ts`, `.env.example`, all `validEnv` blocks across test files |
| 3 | `packages/shared/src/constants.test.ts` (or extend existing) | `packages/shared/src/constants.ts`, `packages/fulfillment/src/tracking-poller.ts`, `packages/fulfillment/src/tracking-poller.test.ts`, `packages/fulfillment/src/printify-webhook.ts` |
| 4 | `packages/shared/src/etsy-taxonomy.ts`, `packages/shared/src/etsy-taxonomy.test.ts` | `packages/shared/src/index.ts`, `packages/listing/src/publisher.ts`, `packages/listing/src/constants.ts`, `packages/listing/src/publisher.test.ts`, `packages/listing/tests/integration/publisher-flow.test.ts` |
| 5 | — | `.claude/skills/etsy/SKILL.md` |

---

## End-to-End Verification After All Steps

1. `npm run build --workspace=packages/shared` — shared dist rebuilt with new exports.
2. `npm run typecheck` — clean across all workspaces.
3. `npm test --workspaces` — all unit tests pass.
4. Spot-check the etsy skill file is correct (read it; confirm no stale warnings).
5. Manual smoke (when Etsy creds are live, separate session — out of scope for this plan):
   - Bootstrap: run `scripts/get_etsy_readiness_state.ts`, paste the ID into env.
   - Publish a draft listing end-to-end: confirm `taxonomy_id` was looked up and cached, `readiness_state_id` was sent.
   - Trigger a real Etsy webhook from the Etsy dashboard's webhook tester: confirm signature verifies and the receipt is processed.
   - Trigger a Printify shipment with a non-canonical carrier name: confirm `submitTracking` is skipped + Slack alert fires.

---

## Notes for the Executor

- **Build the shared package after Step 1, Step 2, Step 3, AND Step 4 changes** before running `npm run typecheck` in downstream packages — the same caching gotcha that bit us during the Printify compliance work.
- **Don't remove `ETSY_API_SECRET`** in Step 1. It's still the API auth secret used elsewhere; only the WEBHOOK secret is being separated out.
- **Step 4 caching** — the `config` table upsert uses key `etsy_taxonomy_${productKey}`. If the team needs to invalidate the cache, delete that row in Supabase.
- **Per user preference** ("Save plans as repo artifacts before executing"), the very first executor action should be `mv` this plan file from `~/.claude/plans/please-make-a-plan-iterative-dawn.md` to `PLAN_ETSY_BUG_FIXES.md` in the repo root, then commit it as a separate commit before starting Step 1.
