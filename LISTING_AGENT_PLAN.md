# Listing Agent — Build Plan

## Context

The Listing Agent is the third link in the 4-agent Etsy/Printify pipeline (see `CLAUDE.md`). It polls `design_packages` rows where `status='done'`, generates SEO-optimized Etsy copy via Claude Sonnet, creates a hidden Printify product (which gives us mockups as a side effect), optionally pauses for human review, then publishes the listing on Etsy and flips the Printify product visible. It writes one `listings` row per design package, ending in `status='active'` (or `needs_review` when human review is on).

Scout and Design are Python; this is the **first TypeScript agent** in the repo. There is currently **no root `package.json`, no npm workspaces, and no `packages/shared/` TS package**. This plan therefore has to set up the TypeScript half of the monorepo before building the agent itself. Where Python infrastructure exists (`packages/shared_py/`, `infra/supabase/migrations/001`+`002`, the `claim_pending_trend_brief()` RPC pattern), this plan mirrors it in TS rather than reinventing the conventions.

Per decisions made before planning:
- **Scope:** v1 supports the Gildan 64000 t-shirt only — same blueprint and variant set the Design agent uses. Multi-product support is a later plan.
- **Mockups:** Read from the Printify "create product" response and write back to `design_packages.mockup_urls`. There is no standalone mockup endpoint (per CLAUDE.md "Agent 2" note).
- **Human review:** When `HUMAN_REVIEW_ENABLED=true` (the default), listings stop at `status='needs_review'`. v1 uses a small CLI script (`scripts/approve-listing.ts`) to flip a row to `pending_publish`; a real admin UI is deferred. When the flag is `false`, listings flow straight through.
- **Etsy OAuth tokens:** Stored in a new Supabase `config` table per CLAUDE.md ("rotate too frequently for static config"). The `ETSY_ACCESS_TOKEN` / `ETSY_REFRESH_TOKEN` env vars in `.env.example` are used only as the **initial seed** on first run, after which the DB row is the source of truth.
- **Schedule:** v1 runs manually via `npm run start --workspace=packages/listing`. No Railway cron registration. Cron gets added once Etsy OAuth + listing publish are validated against the real API.
- **Pricing:** v1 uses one flat `price_usd` for every Printify variant. Per-variant pricing is a later plan. Floor enforced at `price_usd >= print_cost × 2.5` on the most expensive variant, accounting for Etsy fees per CLAUDE.md "Estimated Per-Unit Economics".
- **Taxonomy ID:** Hardcoded constant for the Etsy "Clothing → Unisex Adult Clothing → Tops & Tees → T-shirts" taxonomy (since v1 is t-shirts only). A real lookup table is a later plan.
- **Shipping profile ID:** A single profile is created manually via the Etsy dashboard before first run; its ID is supplied via env var `ETSY_SHIPPING_PROFILE_ID`. Documented in step 22's manual verification.

The plan is broken into 24 sequential steps grouped into 11 phases. Each step is small enough for one focused Sonnet pass.

---

## Phase A — Workspace prerequisites (TypeScript bootstrap)

### Step 1: Root `package.json` with npm workspaces
Create `/package.json` at the repo root with:
- `"private": true`
- `"workspaces": ["packages/*"]`
- `"engines": { "node": ">=20" }`
- `"type": "module"`
- A single root script: `"test:ts": "npm test --workspaces --if-present"` (Python tests are still run via `pytest` per CLAUDE.md)
- Dev dependencies (root only): `typescript@5.4`, `@types/node@20`, `tsx@4` (for `node --import tsx ...` running of TS files locally), `vitest@1`, `prettier@3`, `eslint@9` + `@typescript-eslint/*`

### Step 2: Root `tsconfig.base.json`
Strict TypeScript settings per CLAUDE.md "TypeScript" coding standards:
- `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`
- `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`
- `"declaration": true`, `"composite": true`
- Per-package `tsconfig.json` extends this base

### Step 3: Migration `infra/supabase/migrations/003_listings.sql`
Create the migration with:
- The `listings` table verbatim from CLAUDE.md "Database Schema" section
- `CREATE INDEX idx_listings_status ON listings(status);`
- `CREATE INDEX idx_listings_etsy_id ON listings(etsy_listing_id);`
- `CREATE TRIGGER trg_listings_updated ...` (reuses `update_timestamp()` from migration 001 — do NOT redefine)
- A `config` table for rotating Etsy OAuth tokens (single-row pattern, key/value JSONB):
  ```sql
  CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TRIGGER trg_config_updated BEFORE UPDATE ON config FOR EACH ROW EXECUTE FUNCTION update_timestamp();
  ```
- A Postgres function `claim_pending_design_package()` that atomically claims one row and bumps it to `'processing'` (mirrors `claim_pending_trend_brief()` from migration 002):
  ```sql
  CREATE OR REPLACE FUNCTION claim_pending_design_package()
  RETURNS SETOF design_packages AS $$
    UPDATE design_packages
    SET status = 'processing'
    WHERE id = (
      SELECT id FROM design_packages
      WHERE status = 'done'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  $$ LANGUAGE sql;
  ```
  (Note: design_packages start at `'done'` from Design's perspective; we transition them to `'processing'` here. The Listing agent owns this state machine for design_packages from this point on. Document this in a one-line comment in the SQL file.)

### Step 4: Apply migration to cloud Supabase
- `supabase db push` (pushes to the linked cloud project)
- Verify via Supabase dashboard (Table Editor) or `supabase inspect db schema --linked`: confirm `listings` and `config` tables exist and `claim_pending_design_package` function appears under Database → Functions. A call returning empty set (no eligible rows) is success.

---

## Phase B — Shared TypeScript package

### Step 5: `packages/shared/` skeleton
Create:
- `packages/shared/package.json` — name `@presswork/shared`, type `"module"`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"exports"` for `./db`, `./config`, `./logger`, `./types`. Build script `"build": "tsc -b"`, test script `"test": "vitest run"`.
- `packages/shared/tsconfig.json` — extends root base, `"outDir": "./dist"`, `"rootDir": "./src"`
- `packages/shared/src/index.ts` — re-exports from the four submodules below
- Dependencies: `@supabase/supabase-js@2`, `pino@9`, `zod@3`. Dev: `vitest@1`, `@types/node@20`.

### Step 6: `packages/shared/src/config.ts`
Mirror `packages/shared_py/config.py` exactly:
- A `zod` schema reading from `process.env`, validating each variable from `.env.example` (Anthropic, Etsy, fal, Printify, Supabase, Resend, Slack, runtime)
- Plus one new var: `ETSY_SHIPPING_PROFILE_ID: z.coerce.number().int()` (added to `.env.example` in step 22)
- Boolean coercion for `HUMAN_REVIEW_ENABLED` (`"true"` → `true`)
- Export `getSettings(): Settings` memoized via a module-level `let _cached: Settings | undefined` (TS equivalent of Python's `@lru_cache`)
- Throws on missing required vars at first call (fail-fast)

### Step 7: `packages/shared/src/db.ts`
Mirror `packages/shared_py/db.py`:
- `getDb()` returns a memoized `SupabaseClient` created with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- Decode the JWT (no verification — supabase-js does that on the wire); assert the `role` claim is `"service_role"` and throw otherwise. This catches the common mistake of passing the anon key.
- Export `Db` type alias for `SupabaseClient`

### Step 8: `packages/shared/src/logger.ts`
Mirror `packages/shared_py/logger.py`:
- Pino logger with `LOG_LEVEL` from settings, JSON output, `base: { agent }` so every line includes the agent name
- `getLogger(agent: string): Logger` factory
- The fields per CLAUDE.md "Logging" contract are: `agent, action, record_id, status, duration_ms, error?` — every call site populates these explicitly (the logger itself only adds `agent`)

### Step 9: `packages/shared/src/types.ts`
Zod schemas + inferred types for the rows the Listing agent reads/writes. **Mirror `packages/shared_py/models.py` field-for-field where the columns overlap.**
- `DesignPackageSchema` / `DesignPackage` — fields matching `design_packages` columns
- `TrendBriefSchema` / `TrendBrief` — needed because Listing joins design_packages → trend_briefs for the copywriter prompt
- `ListingStatusSchema` — `z.enum(['pending', 'needs_review', 'pending_publish', 'publishing', 'active', 'error'])`
  - Note: CLAUDE.md's status set is `pending → needs_review → publishing → active`. We add `pending_publish` between `needs_review` and `publishing` so the human-review approval has somewhere to land (otherwise the row sits at `needs_review` forever after approval). Document this in the type comment.
- `ListingSchema` / `Listing` — fields matching the `listings` table
- `ListingCopySchema` / `ListingCopy` — Claude's structured output: `title: string` (≤140), `description: string`, `tags: string[]` (length 13). Strict refinements rejecting all-caps, missing AI disclosure, > 13 tags.

### Step 10: `packages/shared/src/etsy-tokens.ts`
A small module to read/write the rotating Etsy OAuth token row in the `config` table.
- `getEtsyTokens(db): Promise<{ accessToken, refreshToken, expiresAt }>` — reads from `config` where `key='etsy_oauth'`. If missing, seeds from `ETSY_ACCESS_TOKEN` / `ETSY_REFRESH_TOKEN` env vars (treats expiry as "now" so the next call refreshes).
- `setEtsyTokens(db, tokens)` — upserts the row.
- This module lives in `shared` because Fulfillment (Agent 4) will reuse it. Tests mock the Supabase client (no real DB needed for unit tests).

### Step 11: `packages/shared/tests/` — unit tests for shared
- `config.test.ts` — valid env parses; missing required var throws; `HUMAN_REVIEW_ENABLED="false"` → `false`
- `db.test.ts` — anon key (role=`anon` JWT) throws; service role key passes
- `logger.test.ts` — log line includes `agent` field automatically
- `etsy-tokens.test.ts` — get-then-set round trip; missing config row falls back to env seed
- All tests use Vitest. No MSW needed at this layer.

---

## Phase C — Listing package skeleton

### Step 12: `packages/listing/` skeleton
Create:
- `packages/listing/package.json` — name `@presswork/listing`, type `"module"`, scripts `"build": "tsc -b"`, `"start": "node --import tsx src/index.ts"`, `"test": "vitest run"`. Depends on `@presswork/shared` (workspace), `@anthropic-ai/sdk`, `bottleneck`, `async-retry`, `zod`. Dev: `vitest`, `msw@2`.
- `packages/listing/tsconfig.json` — extends root base, references `../shared`
- `packages/listing/vitest.config.ts` — node environment, MSW setup file
- `packages/listing/src/` — empty for now
- `packages/listing/README.md` — placeholder, filled in step 23

### Step 13: `packages/listing/src/constants.ts`
Module-level constants for the t-shirt-only v1 scope:
- `ETSY_TAXONOMY_ID_TSHIRT: number` — the Etsy taxonomy ID for "Clothing → Unisex Adult Clothing → Tops & Tees → T-shirts" (look up via `GET /application/seller-taxonomy/nodes`; document the lookup result in a one-line comment with the date checked)
- `AI_DISCLOSURE_TEXT = "This design was created using AI image generation tools."` — the exact phrasing from CLAUDE.md "Key Business Rules"
- `MAX_ETSY_REQ_PER_SEC = 10` — for Bottleneck (per CLAUDE.md "Etsy rate limits")
- `MAX_ETSY_REQ_PER_DAY = 10000`
- `LISTING_DEFAULTS` — `{ who_made: "i_did", when_made: "made_to_order", is_supply: false, state: "draft" }`
- `MAX_TAGS = 13`, `MAX_TITLE_LEN = 140`

---

## Phase D — Polling

### Step 14: `packages/listing/src/poller.ts`
- `export async function claimNextDesignPackage(db: Db): Promise<DesignPackage | null>`
- Calls `db.rpc('claim_pending_design_package')` and parses the first row through `DesignPackageSchema`
- Returns `null` if no rows. The RPC handles the `FOR UPDATE SKIP LOCKED` + status flip atomically.

### Step 15: `packages/listing/tests/integration/poller.test.ts`
Gated by `INTEGRATION=1` (mirror scout's pattern: `if (!process.env.INTEGRATION) test.skip(...)`).
Connects to the cloud Supabase project via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env` — no local Supabase container needed.
- Setup: insert two design_packages rows (with status `'done'` and a synthesized parent trend_brief)
- Assert: `claimNextDesignPackage(db)` returns one of them; that row's status is now `'processing'`
- Assert: a second call returns the other; a third returns `null`
- Concurrency: spawn 10 promises against 5 eligible rows; assert exactly 5 distinct rows claimed and 5 nulls (no double-claims)
- Teardown: delete the test rows by id (always run in `afterAll`, even on test failure, to avoid polluting the cloud DB)

---

## Phase E — Copywriter (Claude Sonnet)

### Step 16: `packages/listing/src/copywriter.ts`
- `export async function writeCopy(brief: TrendBrief, design: DesignPackage): Promise<ListingCopy>`
- Uses `@anthropic-ai/sdk` with `claude-sonnet-4-20250514` (mirror scout's `analyzer.py`):
  - System block uses `cache_control: { type: 'ephemeral' }`
  - `max_tokens: 1024`, no streaming
  - Parses `response.content[0].text` as JSON, validates against `ListingCopySchema`
- System prompt is the exact one in CLAUDE.md "Agent 3 — Listing" (`You are an expert Etsy SEO copywriter ...`), with one addition: a paragraph instructing Claude that the description **must contain the AI disclosure sentence verbatim**.
- User message: JSON dump of `{ niche, style_keywords, top_tags, color_palette, price_target_usd }` from the trend_brief plus `{ blueprint_id, variant_count }` from the design_package.
- Post-validation enforced by Zod refinements in `ListingCopySchema`:
  - Title ≤ 140 chars
  - Exactly 13 tags
  - Each tag ≤ 20 chars (Etsy hard limit)
  - Description includes `AI_DISCLOSURE_TEXT` substring
  - Title is not all-caps
- Throws a typed `CopywriterError` with the validation issues so the orchestrator can decide whether to retry.

### Step 17: `packages/listing/src/copywriter.test.ts`
Unit tests with the Anthropic SDK mocked via `vi.mock('@anthropic-ai/sdk', ...)`:
- Happy path: valid JSON parses to `ListingCopy`
- Missing AI disclosure → throws (Zod refinement)
- Title > 140 chars → throws
- 12 or 14 tags → throws
- All-caps title → throws
- The system message is sent with `cache_control: { type: 'ephemeral' }`

---

## Phase F — Pricing & validation

### Step 18: `packages/listing/src/pricing.ts`
- `export function validatePricingFloor(priceUsd: number, printCostUsd: number): void`
- Computes the Etsy fee load per CLAUDE.md "Estimated Per-Unit Economics":
  - 6.5% transaction fee + 3% payment processing + $0.25 + $0.20 listing fee
- Rejects when `priceUsd < printCostUsd * 2.5`
- Throws `PricingFloorError` with both numbers in the message
- Pure function. Trivially testable.

### Step 19: `packages/listing/src/pricing.test.ts`
- Boundary test at exactly `2.5×` (passes)
- Just under (fails)
- Just over (passes)
- Net-margin sanity check at the canonical `$24.99` example from CLAUDE.md (margin ≈ $9.87)

---

## Phase G — Etsy OAuth + API client

### Step 20: `packages/listing/src/etsy-auth.ts`
Etsy OAuth 2.0 access tokens expire every hour (CLAUDE.md "Etsy OAuth 2.0 Reference"). This module owns the refresh flow.
- `export async function getValidAccessToken(db: Db): Promise<string>`
- Reads tokens via `getEtsyTokens(db)` from shared. If `expiresAt` is more than 60 seconds in the future, returns the access token as-is.
- Otherwise POSTs to `https://api.etsy.com/v3/public/oauth/token` with `grant_type=refresh_token`, `client_id={ETSY_API_KEY}`, `refresh_token={current refresh}`.
- Persists the new `{accessToken, refreshToken, expiresAt}` via `setEtsyTokens(db, ...)` and returns the new access token.
- Tests with MSW: happy path, refresh-near-expiry triggers a token endpoint call, expired refresh token → typed `EtsyAuthError`.

### Step 21: `packages/listing/src/etsy-api.ts`
Etsy API v3 client — every external request goes through this module.
- A Bottleneck instance (`new Bottleneck({ maxConcurrent: 1, minTime: 100 })` → 10 req/sec cap per CLAUDE.md). Singleton at module scope so the daily 10k cap is also approximated when callers respect the limiter.
- `async-retry` for transient 5xx / 429 (max 3 attempts, exponential backoff). 4xx (non-429) bubbles immediately.
- A thin `etsyFetch(db, path, init)` helper that:
  1. Calls `getValidAccessToken(db)` (cached, refreshes only when needed)
  2. Adds `Authorization: Bearer ${token}`, `x-api-key: ${ETSY_API_KEY}`
  3. Schedules through Bottleneck and retries through async-retry
  4. Parses the JSON response; rejects non-2xx with the Etsy error body included in the thrown error
- Typed wrappers: `createDraftListing(db, payload)`, `uploadListingImage(db, listingId, imageUrl, rank)`, `activateListing(db, listingId)`. Each wrapper validates its response with a Zod schema (per CLAUDE.md "TypeScript" rules — no `any`).

### Step 22: `packages/listing/src/etsy-api.test.ts`
Unit tests with MSW:
- `createDraftListing`: happy path returns the listing id; payload includes `taxonomy_id`, `who_made: "i_did"`, `state: "draft"`, `shipping_profile_id`
- `uploadListingImage`: succeeds; image rank is honored
- `activateListing`: PATCHes `state: "active"`
- 429 → retried 3x then succeeds; assert exactly 3 retry attempts hit the mock
- 401 from a stale token: re-calls the OAuth refresh endpoint and retries the original request once
- A 4xx (other than 401/429) is NOT retried

---

## Phase H — Printify product

### Step 23: `packages/listing/src/printify.ts`
- `export async function createHiddenProduct(input): Promise<{ productId: string; mockupUrls: string[] }>`
  - POST `https://api.printify.com/v1/shops/{PRINTIFY_SHOP_ID}/products.json` with the body shape from CLAUDE.md "Agent 3 — Listing" (image, blueprint_id, variant_ids, `is_visible: false`)
  - Reads `images[].src` from the response (Printify auto-generates mockups on product creation)
  - Returns the Printify product id and the mockup URL list
- `export async function setProductVisible(productId): Promise<void>`
  - PUT to `/v1/shops/{shop}/products/{id}.json` with `{ is_visible: true }`
- `async-retry` on 5xx; 4xx surfaces immediately. Bearer auth from `PRINTIFY_API_TOKEN`.
- After `createHiddenProduct` returns, the orchestrator (step 25) writes `mockupUrls` back to `design_packages.mockup_urls` per CLAUDE.md "Agent 2 — Design" note.

### Step 24: `packages/listing/src/printify.test.ts`
MSW unit tests:
- Happy path: returns product id + ≥1 mockup URL
- Empty `images[]` in response → typed `PrintifyError`
- 5xx retried; 4xx surfaces with the Printify error body in the message
- `setProductVisible` issues a PUT with `is_visible: true`

---

## Phase I — Publisher (orchestration unit)

### Step 25: `packages/listing/src/publisher.ts`
The publisher is the unit-testable orchestrator. `main.ts` (step 26) is a thin loop around it.
- `export async function publishOne(db, copywriter, design, brief): Promise<{ listingId: string; etsyListingId: number }>`
- Steps:
  1. `validatePricingFloor(brief.price_target_usd, printCostUsd)` — `printCostUsd` is read from a per-blueprint constant for v1 (Gildan 64000 = $8.50 per CLAUDE.md "Estimated Per-Unit Economics"); future plans replace this with a Printify catalog lookup
  2. `copy = await writeCopy(brief, design)` — Claude
  3. Insert `listings` row with `status='pending'`, the copy fields, and `price_usd = brief.price_target_usd`
  4. `{ productId, mockupUrls } = await createHiddenProduct({...})` — Printify
  5. `db.from('design_packages').update({ mockup_urls: mockupUrls }).eq('id', design.id)` — write mockups back
  6. Branch on `HUMAN_REVIEW_ENABLED`:
     - **true:** flip `listings.status` to `'needs_review'`, return early. The CLI script in step 27 takes over.
     - **false:** flip to `'pending_publish'` and fall through to step 7.
  7. Flip `listings.status` to `'publishing'`
  8. `etsyListingId = await createDraftListing(...)` — Etsy
  9. For each mockup URL: `await uploadListingImage(...)` (preserve order so the design front-mockup is rank 1)
  10. `await activateListing(etsyListingId)` — Etsy
  11. `await setProductVisible(productId)` — Printify (only AFTER Etsy is live, to avoid a visible orphan product if Etsy fails)
  12. Update `listings`: `status='active'`, `etsy_listing_id`, `is_active=true`
- Wrap each external call's failure with the standard retry/error path: on exception, record the error on `listings` (`error_message`, `retry_count++`); if `retry_count < 3`, flip back to `'pending'` (CLAUDE.md "Error Handling & Retries"). Otherwise leave at `'error'`.
- Logs every action per CLAUDE.md contract: `agent: "listing", action, record_id, status, duration_ms, error?`.

### Step 26: `packages/listing/src/publisher.test.ts`
MSW + Vitest unit tests for the orchestrator:
- Happy path with `HUMAN_REVIEW_ENABLED=false`: row ends at `'active'`; `setProductVisible` was called AFTER `activateListing`
- `HUMAN_REVIEW_ENABLED=true`: row stops at `'needs_review'`; Etsy endpoints were never hit
- Pricing floor breach: throws before any Printify/Etsy call
- Etsy `activateListing` fails: row ends at `'error'` with `retry_count=1`, `setProductVisible` was NOT called (Printify product remains hidden — important so we don't leak orphans)
- Third failure: row stays at `'error'` with `retry_count=3`, does NOT flip back to `'pending'`

### Step 27: `scripts/approve-listing.ts`
A small CLI for v1 human review (run via `npx tsx scripts/approve-listing.ts <listing_id>`):
- Reads the row, prints title/description/tags/mockup URLs to stdout
- Prompts `[y/N]`
- On `y`, updates the row's status from `'needs_review'` to `'pending_publish'`. The next `npm run start --workspace=packages/listing` picks it up and continues from step 7 of `publishOne`.
- This script lives in the existing `scripts/` directory at the repo root (alongside `seed-niches.ts` mentioned in CLAUDE.md).

---

## Phase J — Main entry point

### Step 28: `packages/listing/src/index.ts`
The thin polling loop. Mirrors scout's `main.py` shape.
```ts
export async function run(): Promise<void> {
  const log = getLogger("listing");
  const db = getDb();
  while (true) {
    // Two queues: fresh design_packages claimed via RPC, OR
    // listings already at 'pending_publish' (post-approval) that need to resume.
    const approved = await fetchPendingPublishListing(db);
    if (approved) { await resumePublish(db, approved); continue; }

    const design = await claimNextDesignPackage(db);
    if (!design) { log.info({ action: "no_pending", status: "idle" }); break; }

    const brief = await fetchTrendBrief(db, design.trend_brief_id);
    try {
      await publishOne(db, design, brief);
    } catch (e) {
      log.error({ action: "listing_failure", record_id: design.id, error: String(e) });
      // publishOne already wrote the error/retry state to the listings row.
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
```
- `resumePublish` re-enters `publishOne` at step 7 (Etsy draft → activate → flip Printify visible).
- The loop drains all eligible work then exits — same shape as scout (no long-lived process). Cron schedule comes later.

### Step 29: `packages/listing/tests/integration/main.test.ts`
Gated by `INTEGRATION=1`. Connects to cloud Supabase via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. All external APIs (Anthropic, Etsy, Printify) are mocked at the HTTP layer — no real API keys needed for this test.
- Mock Anthropic via `vi.mock('@anthropic-ai/sdk')` (returns a valid `ListingCopy` JSON)
- Mock Etsy + Printify endpoints with MSW
- Setup: insert one trend_brief + one design_package (status `'done'`) into cloud DB
- Run: `await run()`
- Assert with `HUMAN_REVIEW_ENABLED=false`:
  - one new `listings` row with `status='active'` and a non-null `etsy_listing_id`
  - `design_packages.mockup_urls` is populated (≥1 URL)
  - the source `design_packages.status` is `'processing'` then ends at `'done_listed'` — actually leave at `'processing'` per the design plan unless a separate transition is added; document in this test file
- Assert with `HUMAN_REVIEW_ENABLED=true`: row stops at `'needs_review'`; no Etsy mock was hit
- Failure-path test: configure the Etsy `activateListing` mock to 500 three times; assert third attempt leaves row at `'error'` with `retry_count=3`
- Teardown: delete inserted rows in `afterAll` (always runs to avoid polluting cloud DB)

---

## Phase K — Polish & verification

### Step 30: `.env.example` and CI updates
- Append `ETSY_SHIPPING_PROFILE_ID=` to `.env.example`
- Add a `npm run test:listing` step to whichever CI workflow runs the TS unit tests (per CLAUDE.md "CI/CD" — `ci.yml`)
- Add path filtering: `packages/listing/**` and `packages/shared/**` and `infra/supabase/migrations/**` trigger this job (per CLAUDE.md "Path filtering")
- Integration tests in CI (`integration.yml`) connect to cloud Supabase — no `supabase start` or Docker container needed. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as GitHub Actions secrets scoped to the integration job. Do NOT use `supabase/setup-cli` or spin up a local stack in CI.

### Step 31: Fill in `packages/listing/README.md`
Mirror scout's README structure (translated to TS). Cover:
- What listing does (1 paragraph)
- Local setup: install Node 20, `npm install` at the repo root
- Required env vars (link to root `.env.example`; flag that `ANTHROPIC_API_KEY`, `ETSY_API_KEY`, `ETSY_API_SECRET`, `ETSY_SHOP_ID`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, `ETSY_SHIPPING_PROFILE_ID`, `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID` must be real for end-to-end runs)
- How to run: `npm run start --workspace=packages/listing`
- How to test: `npm test --workspace=packages/listing` (unit) and `INTEGRATION=1 npm test --workspace=packages/listing` (integration)
- v1 scope notes: t-shirts only, single price across variants, manual run, hardcoded taxonomy ID — link to this plan file for the rationale
- How to approve a listing in human-review mode: `npx tsx scripts/approve-listing.ts <listing_id>`

### Step 32: End-to-end manual verification
1. Confirm migrations 001–003 are applied to the cloud Supabase project: `supabase migration list --linked`. Confirm the `designs` storage bucket exists (create via Supabase dashboard → Storage if not).
2. Create one Etsy shipping profile via the Etsy seller dashboard. Copy its ID to `.env` as `ETSY_SHIPPING_PROFILE_ID`.
3. Confirm an Etsy OAuth bootstrap pair exists: `ETSY_ACCESS_TOKEN` + `ETSY_REFRESH_TOKEN` populated in `.env`. The first run will move them into the cloud `config` table.
4. A real `design_packages` row at `status='done'` with a real Supabase Storage `image_url` should already exist from a prior Design agent run. If not, insert a hand-crafted `trend_briefs` row and run Design once.
5. Populate `.env` with real `ANTHROPIC_API_KEY`, `ETSY_*`, `PRINTIFY_*`, `SUPABASE_*` (pointing at the cloud project). Set `HUMAN_REVIEW_ENABLED=true` (the default).
6. Run: `npm run start --workspace=packages/listing`
7. Verify via Supabase dashboard (Table Editor → listings): one new row with `status='needs_review'`, non-null `title/description/tags/price_usd`. Check `design_packages` row — `mockup_urls` is populated.
8. Inspect copy + mockups (open mockup URLs in browser), then run `npx tsx scripts/approve-listing.ts <listing_id>` and confirm `[y]`.
9. Re-run `npm run start --workspace=packages/listing`
10. Verify via Supabase dashboard: row is now `status='active'`, `etsy_listing_id` set, `is_active=true`.
11. Open the Etsy listing in the seller dashboard → confirm title/description/tags/images render correctly. Confirm the listing is live.
12. Open Printify dashboard → confirm the product exists, is visible, and the variant set matches.
13. Cost check: confirm Anthropic dashboard shows ~$0.01 spent for the run; Etsy shows the listing fee ($0.20).

---

## Critical files to be created

| Path | Purpose |
|---|---|
| `/package.json` | Root npm workspaces config |
| `/tsconfig.base.json` | Shared strict TS settings |
| `infra/supabase/migrations/003_listings.sql` | DB schema, `config` table, `claim_pending_design_package()` RPC |
| `packages/shared/package.json` | TS shared package manifest |
| `packages/shared/src/{config,db,logger,types,etsy-tokens}.ts` | TS analogs of `shared_py` plus rotating-token store |
| `packages/listing/package.json` | Listing agent manifest |
| `packages/listing/src/constants.ts` | Taxonomy ID, AI disclosure text, rate limits, defaults |
| `packages/listing/src/poller.ts` | RPC-based atomic claim of next design_package |
| `packages/listing/src/copywriter.ts` | Claude Sonnet → title/description/tags |
| `packages/listing/src/pricing.ts` | Floor enforcement (`price_usd >= print_cost × 2.5`) |
| `packages/listing/src/etsy-auth.ts` | OAuth refresh flow against `config` table |
| `packages/listing/src/etsy-api.ts` | Etsy API v3 client (Bottleneck + async-retry, Zod-validated) |
| `packages/listing/src/printify.ts` | Hidden product create + visibility flip |
| `packages/listing/src/publisher.ts` | Orchestrator: copy → Printify → (review) → Etsy → activate |
| `packages/listing/src/index.ts` | Polling loop entry point |
| `scripts/approve-listing.ts` | CLI to flip `needs_review` → `pending_publish` |
| `packages/listing/README.md` | Setup and run docs |

## Reused references

- `packages/shared_py/{config,db,logger,models}.py` is the field-for-field reference for the new TS `packages/shared/src/*` modules
- The Anthropic call shape (system block with `cache_control: 'ephemeral'`, `max_tokens: 1024`, JSON-only response, schema validation) is the TS port of `packages/scout/analyzer.py`
- The retry pattern (3 attempts, exponential backoff, no retry on 4xx) is the `async-retry` port of `packages/scout/etsy_client.py`'s tenacity usage
- The `claim_pending_design_package()` RPC mirrors `claim_pending_trend_brief()` from migration 002 — same `FOR UPDATE SKIP LOCKED` shape
- The integration-test skeleton (gating, fixtures, teardown via direct DB calls) is ported from `packages/scout/tests/integration/`
- The `update_timestamp()` SQL function from migration 001 is reused — do NOT redefine it in 003

## Verification (end-to-end)

The plan is complete when step 32 succeeds: listing runs against the cloud Supabase project + real Anthropic + real Etsy + real Printify APIs, picks up one Design-produced `done` design_package, generates copy + mockups, pauses for review, publishes on approval, and writes one `active` `listings` row with a real `etsy_listing_id` linking to a live Etsy listing whose images came from Printify mockups. The `design_packages.mockup_urls` column is populated. All unit tests pass; integration tests pass under `INTEGRATION=1` (connecting to cloud Supabase). Failure-path retry behavior is verified by the failure-path integration test in step 29.
