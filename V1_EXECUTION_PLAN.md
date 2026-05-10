# V1_EXECUTION_PLAN.md — Sequenced execution of V1_AND_BEYOND.md

**Source:** `V1_AND_BEYOND.md` recommended sequence: 4 → 5 → 3 → 1 → 2 → 7 → 4 → 6
**Drafted:** 2026-05-09
**Total estimated effort:** ~12–17 hours, broken into 13 single-session steps

## Context

Etsy API access was denied; storefront re-application is in flight. While that's pending, this plan executes the V1_AND_BEYOND.md recommended-sequence items against MSW mocks. Every step below is sized for a single focused Sonnet session (≤ 2 hours of editing) and can be merged independently. Steps are strictly sequential — finish-then-merge before starting the next.

**Invariants for every step:**
- All Etsy / Printify / fal.ai / Anthropic calls are mocked at the HTTP layer (CLAUDE.md Testing section). Hit a real local Supabase (`supabase start`) for any DB integration test.
- Each step ends green: lint + typecheck + unit tests pass before the next step begins.
- Migrations are added in execution order, not item order — `005`, `006`, `007` are reserved across this plan (see step 6 and step 12).

## Step index

| # | Source item | Title | Est. |
|---|---|---|---|
| 1  | 4a | Design Agent: same-row fal.ai retry guard | 60 min |
| 2  | 5a | Port `notifier.py` to `shared-py` | 30 min |
| 3  | 5b | Wire Slack alerts into Scout and Design | 90 min |
| 4  | 3a | Add lint + typecheck scripts (TS + Python) | 60 min |
| 5  | 3b | Author `.github/workflows/ci.yml` | 30 min |
| 6  | 1a | Persist `printify_product_id` on `listings` | 30 min |
| 7  | 1b | Implement Etsy listing wrappers in `etsy-api.ts` | 90 min |
| 8  | 1c | Wire `publisher.ts` + `resumePublish` | 45 min |
| 9  | 2  | Listing publish integration test | 120 min |
| 10 | 7a | E2E smoke test: scaffolding + Scout→Design half | 90 min |
| 11 | 7b | E2E smoke test: Listing→Fulfillment half | 90 min |
| 12 | 4b | Design Agent: cross-row fal_prompt_hash dedup | 90 min |
| 13 | 6  | Scout semantic dedup via Claude Sonnet | 120 min |

---

## Step 1 — Design same-row fal.ai retry guard *(item 4a)*

**Goal:** Stop re-paying fal.ai $0.05 every time a `trend_briefs` row retries after a failure that happened *after* fal.ai succeeded.

**Current state:**
- `packages/design/main.py:30` calls `generate_image` → `process_for_print` → `upload_design` → `db.table("design_packages").insert(...)`. The `design_packages` row is only created on full success (line 35).
- On any post-fal failure, `trend_briefs` flips back to `pending` (line 67–68) and the next run re-calls fal.ai.

**Sub-steps:**
1.1. Restructure `packages/design/main.py` so the `design_packages` row is inserted with `status='processing'` immediately after fal.ai returns (before storage upload), populating `fal_prompt`. Update the same row to `status='done'` once `image_url` is set.
1.2. Add an early-exit guard at the top of the per-brief loop: query `design_packages` by `trend_brief_id`. If a row exists with `image_url` populated, log "design_already_done" and `continue` without calling fal.ai. If a row exists at `processing` without `image_url`, complete the storage-and-update tail without re-calling fal.ai (the fal output is unrecoverable, so on this branch we DO need to re-call fal — accept that and re-fetch; same-row guard primarily protects the storage-failure case after the row is inserted).
1.3. Add unit tests in `packages/design/test_main.py`: (a) first run inserts a row and calls fal.ai exactly once; (b) re-run when a row at `status='done'` already exists for the same trend_brief calls fal.ai zero times. Use `respx` to assert fal.ai HTTP call count.

**Files touched:**
- `packages/design/main.py`
- `packages/design/test_main.py` (new or extend)

**Verification:**
- Unit tests pass.
- Manually: seed one brief, run `python -m packages.design.main` twice; assert fal.ai mock got hit once.

**Open: no migration required this step.** The flow now relies on a SELECT-then-INSERT pattern keyed on `trend_brief_id`, protected by the existing `claim_pending_trend_brief` RPC's `FOR UPDATE SKIP LOCKED`. UNIQUE constraint is unnecessary because only one worker can hold the brief at a time.

---

## Step 2 — Port `notifier.py` to `shared-py` *(item 5a)*

**Goal:** Mirror `packages/shared/src/notifier.ts` in Python so Scout and Design can alert.

**Current state:**
- `packages/shared/src/notifier.ts:4-28` has `notifySlack(message, opts?)` — reads `SLACK_WEBHOOK_URL`, no-ops if unset, swallows all errors.
- `packages/shared-py/notifier.py` does not exist.

**Sub-steps:**
2.1. Create `packages/shared-py/notifier.py` with `async def notify_slack(message: str, severity: Literal["info", "warn", "error"] = "info") -> None`. Use `httpx.AsyncClient`. Read `SLACK_WEBHOOK_URL` via the existing `packages/shared_py/config.py` settings model. No-op + log warning if unset. Catch all exceptions internally; never raise.
2.2. Add `packages/shared-py/test_notifier.py`: (a) raises nothing when env unset (assert log warning), (b) posts to webhook when env set (mock with `respx`), (c) swallows HTTP 500 silently.

**Files touched:**
- `packages/shared-py/notifier.py` (new)
- `packages/shared-py/test_notifier.py` (new)

**Verification:** `pytest packages/shared-py` green.

---

## Step 3 — Wire Slack alerts into Scout and Design *(item 5b)*

**Goal:** Stop silent failures in Scout and Design.

**Current state:**
- `packages/scout/main.py:55-62` only `log.error`s on per-niche failure. **No `trend_briefs` row is created on failure** — Scout has no row-level retry budget; failures are per-niche per-cron-run.
- `packages/design/main.py:58-78` increments `trend_briefs.retry_count` and logs but does NOT call any notifier when `retry_count >= 3`.

**Sub-steps:**
3.1. In `packages/scout/main.py:55` `except` block, after the `log.error` call, await `notify_slack(f"Scout failed for niche '{niche}': {e}", severity="error")`. Per-niche alert each fatal failure (one per cron run per failed niche).
3.2. In `packages/design/main.py`, in the path where retry_count crossed to >= 3 (currently the `else` branch implied at line 67), await `notify_slack(f"Design hit retry ceiling for trend_brief={brief_id}: {e}", severity="error")`. Only fire when the retry budget is exhausted.
3.3. Tests:
- `packages/scout/test_main.py`: simulate `etsy.fetch_top_listings` raising → assert `notify_slack` called exactly once with severity=error.
- `packages/design/test_main.py`: two cases — incoming `retry_count=1` and failure → no alert; incoming `retry_count=2` and failure (becomes 3) → exactly one alert.

**Files touched:**
- `packages/scout/main.py`
- `packages/design/main.py`
- `packages/scout/test_main.py` (new or extend)
- `packages/design/test_main.py` (extend)

**Verification:** Set `SLACK_WEBHOOK_URL` to a request-bin URL, force a fal failure, confirm webhook received the alert.

---

## Step 4 — Add lint + typecheck scripts *(item 3a)*

**Goal:** Get the repo to a clean baseline so step 5's CI doesn't fire red on day one.

**Current state:**
- Root `package.json` has only `"test:ts": "npm test --workspaces --if-present"`. No `lint` or `typecheck` scripts.
- No `.eslintrc*`, no `pyrightconfig.json`, no `ruff.toml` at root.
- `requirements-dev.txt` exists in `packages/scout` and `packages/design` but content needs verification.

**Sub-steps:**
4.1. Add to root `package.json`: `"lint": "npm run lint --workspaces --if-present"`, `"typecheck": "npm run typecheck --workspaces --if-present"`.
4.2. Add `"lint": "eslint src --ext .ts"` and `"typecheck": "tsc --noEmit"` to `packages/{shared,listing,fulfillment}/package.json`.
4.3. Add minimal `.eslintrc.cjs` at root extending `eslint:recommended` and `plugin:@typescript-eslint/recommended`. Add `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `typescript` to root devDependencies (verify `typescript` not already installed).
4.4. Add root `pyproject.toml` with `[tool.ruff]` and `[tool.pyright]` sections. Add `ruff` and `pyright` to `packages/{scout,design}/requirements-dev.txt`. Create the same file for `packages/shared-py/` if missing.
4.5. Run all four locally: `npm run lint`, `npm run typecheck`, `ruff check .`, `pyright`. Fix violations or annotate exceptions with TODO comments. Goal: clean baseline.

**Files touched:**
- `package.json`
- `.eslintrc.cjs` (new)
- `pyproject.toml` (new at root)
- `packages/{shared,listing,fulfillment}/package.json`
- `packages/{scout,design,shared-py}/requirements-dev.txt`

**Verification:** All four commands exit zero locally.

---

## Step 5 — Author CI workflow *(item 3b)*

**Goal:** Block PRs that break lint, typecheck, or unit tests.

**Sub-steps:**
5.1. Create `.github/workflows/ci.yml` with two jobs and `paths:` filters per CLAUDE.md guidance:
- **ts** job: triggers on `packages/{shared,listing,fulfillment}/**`, `package.json`, `package-lock.json`, `infra/**`, the workflow file. Steps: checkout → `actions/setup-node@v4` with `cache: 'npm'` → `npm ci` → `npm run lint` → `npm run typecheck` → `npm run test:ts`.
- **python** job: triggers on `packages/{scout,design,shared-py}/**`, `pyproject.toml`, `requirements*.txt`, `infra/**`, the workflow file. Steps: checkout → `actions/setup-python@v5` with `cache: 'pip'` → `pip install -r requirements-dev.txt` per package → `ruff check .` → `pyright` → `pytest packages/scout packages/design packages/shared-py`.
- `infra/supabase/migrations/**` triggers both.
5.2. Push a deliberately broken branch (typo in TS, ruff violation in Python) and confirm both jobs fail at the right step. Revert. Push a clean branch and confirm green.
5.3. Manual UI follow-up (out-of-band, do not script): mark both jobs as required status checks in branch protection.

**Files touched:**
- `.github/workflows/ci.yml` (new)

**Verification:** A clean push goes green; a broken push goes red at the expected step.

**Out of scope this step:** `integration.yml` and `codeql.yml` (deferred per V1_AND_BEYOND.md item 3).

---

## Step 6 — Persist `printify_product_id` on `listings` *(item 1a)*

**Goal:** Schema gap fix that unblocks step 8. Without this column the Printify productId is held only in memory inside `publishOne`, so when the row pauses at `needs_review` or `pending_publish`, `setProductVisible` later in the flow has nothing to call against.

**Sub-steps:**
6.1. Create migration `infra/supabase/migrations/005_listings_printify_product_id.sql`:
```sql
ALTER TABLE listings ADD COLUMN printify_product_id TEXT;
```
6.2. Update `Listing` type in `packages/shared/src/types.ts` and `packages/shared-py/models.py` to include `printify_product_id?: string | null`.
6.3. In `packages/listing/src/publisher.ts:53`, after `createHiddenProduct` returns, persist `productId` to the listings row in the same UPDATE that writes `mockup_urls` (or in a sibling UPDATE).
6.4. Add a one-line test in `packages/listing/src/publisher.test.ts` (or `printify.test.ts`) that mocks Printify and asserts the listings row receives `printify_product_id`.
6.5. Apply migration locally: `npx supabase db reset` against the local stack to verify it applies cleanly from scratch.

**Files touched:**
- `infra/supabase/migrations/005_listings_printify_product_id.sql` (new)
- `packages/shared/src/types.ts`
- `packages/shared-py/models.py`
- `packages/listing/src/publisher.ts`
- `packages/listing/src/publisher.test.ts` (new or extend)

**Verification:** `npx supabase db reset` succeeds; new test passes.

---

## Step 7 — Implement Etsy listing wrappers *(item 1b)*

**Goal:** Replace the three `not yet implemented` stubs in `packages/shared/src/etsy-api.ts:115-132`, mocked with MSW so they can land before Etsy access does.

**Pattern to copy:** `getReceipt` / `listReceipts` (lines 76–99) — Zod-validated response parsing, `etsyFetch` for token refresh + rate limiting.

**Sub-steps:**
7.1. Add Zod schemas in `etsy-api.ts`:
- `EtsyListingCreateInputSchema` (taxonomy_id, who_made, when_made, is_supply, shipping_profile_id, title, description, price, tags, materials, processing_min/max — per CLAUDE.md item 3).
- `EtsyListingResponseSchema` (`listing_id`, `state`, `title`, etc.).
7.2. Replace the stub at lines 115–120 with `createDraftListing(db, input)`: POST `/application/shops/{shop_id}/listings`. Validate `input` with the input schema, validate response with the response schema, return `{ listing_id }`.
7.3. Replace the stub at lines 122–128 with `uploadListingImage(db, listingId, imageUrl)`: POST `/application/shops/{shop_id}/listings/{listing_id}/images`. Etsy expects multipart form-data (download bytes from `imageUrl`, stream as `image` field). `etsyFetch` is JSON-only — add a sibling helper `etsyMultipartFetch` rather than complicating the existing one. Reuse the same Bottleneck limiter and `getValidAccessToken` flow.
7.4. Replace the stub at lines 130–132 with `activateListing(db, listingId)`: PATCH `/application/shops/{shop_id}/listings/{listing_id}` with `{ state: "active" }`. Validate response.
7.5. Add unit tests in `packages/shared/src/etsy-api.test.ts` (new): MSW handlers stub each endpoint; assert wrappers parse responses correctly and surface 4xx as `EtsyApiError`.

**Files touched:**
- `packages/shared/src/etsy-api.ts`
- `packages/shared/src/etsy-api.test.ts` (new)

**Verification:** `npm test --workspace=packages/shared` green for the new wrappers.

---

## Step 8 — Wire `publisher.ts` + `resumePublish` *(item 1c)*

**Goal:** Replace the `void productId; void setProductVisible;` placeholder at `packages/listing/src/publisher.ts:78-91` with the real publish flow, and implement the empty `resumePublish` at lines 127–132.

**Sub-steps:**
8.1. Factor a private helper `executeEtsyPublish(db, listingId, productId, copy, mockupUrls)` inside `publisher.ts` that runs:
1. `createDraftListing` with `title`, `description`, `tags`, `price_usd`, `taxonomy_id`, `shipping_profile_id` (latter two from settings).
2. `for (const url of mockupUrls) await uploadListingImage(db, returnedListingId, url)`.
3. `activateListing(db, returnedListingId)`.
4. `setProductVisible(productId)` (already imported at line 4).
5. Update the `listings` row: `status='active'`, `is_active=true`, `etsy_listing_id=<id>`.

8.2. Replace `publisher.ts:78-91` with: after the `pending_publish` row update, call `executeEtsyPublish(db, listingId, productId, copy, mockupUrls)`.

8.3. Implement `resumePublish(db, listingId)` (lines 127–132):
- SELECT the `listings` row by id; require `status='pending_publish'` (else throw).
- SELECT joined `design_packages.mockup_urls` and `listings.printify_product_id`.
- Re-run copy from the listings row's existing `title`/`description`/`tags`/`price_usd` (no Claude re-call).
- Call `executeEtsyPublish(...)`.
- Same retry/error handling as `publishOne` (try/catch, retry_count increment, status flip).

8.4. Cover with unit tests (Phase 9 covers integration). Mock Printify and Etsy; assert the publisher reaches `status='active'` on the happy path and increments `retry_count` on failure.

**Files touched:**
- `packages/listing/src/publisher.ts`
- `packages/listing/src/publisher.test.ts` (new or extend)

**Verification:** Unit tests pass.

---

## Step 9 — Listing publish integration test *(item 2)*

**Goal:** Catch the seam bugs between Printify create, Etsy draft, image upload, and activation that unit tests don't see.

**Pattern to copy:** `packages/fulfillment/tests/integration/webhook-flow.test.ts` (~350 lines, MSW + local Supabase, gated on `INTEGRATION=1`).

**Sub-steps:**
9.1. Create `packages/listing/tests/integration/publisher-flow.test.ts`. Copy the `webhook-flow.test.ts` skeleton; strip fulfillment-specific handlers; keep MSW + Supabase scaffolding and the `INTEGRATION=1` gate.
9.2. Add MSW handlers:
- Anthropic `/v1/messages` → returns fixed valid `{ title, description, tags }` JSON.
- `api.printify.com/.../products.json` POST → returns `{ id, mock_images: [...] }`.
- `api.printify.com/.../products/{id}/publish.json` POST → 200.
- `openapi.etsy.com/v3/application/shops/{shop_id}/listings` POST → `{ listing_id: 999 }`.
- `openapi.etsy.com/v3/.../listings/{id}/images` POST → 201.
- `openapi.etsy.com/v3/.../listings/{id}` PATCH → `{ state: "active" }`.
9.3. Test cases:
- **Happy path** with `HUMAN_REVIEW_ENABLED=false`: seed `trend_briefs` + `design_packages`, call `publishOne`, assert `listings.status='active'`, `is_active=true`, `etsy_listing_id=999`, `printify_product_id` set, `design_packages.mockup_urls` populated, exactly one POST per endpoint.
- **Human review path** with `HUMAN_REVIEW_ENABLED=true`: same seed, call `publishOne`, assert `listings.status='needs_review'`, zero Etsy POSTs. Then call `resumePublish(db, listingId)`, assert reaches `active`.
- **Retryable failure**: MSW returns 500 once for `activateListing`, then 200. Call `publishOne` → expect throw → assert `retry_count=1`, `status='pending'`. Call again → assert success.
- **Exhausted retries**: MSW always returns 500 for `activateListing`. Run 3 times. Assert final `status='error'`, `retry_count=3`.

**Files touched:**
- `packages/listing/tests/integration/publisher-flow.test.ts` (new)

**Verification:** `INTEGRATION=1 npm test --workspace=packages/listing` green against `supabase start`.

---

## Step 10 — E2E smoke test: scaffolding + Scout→Design half *(item 7a)*

**Goal:** Single test that walks one trend brief from Scout discovery through Design generation, all external HTTP mocked.

**Host language decision:** Author the e2e test in **TypeScript** (Vitest) and shell out to Python via `subprocess` for Scout and Design entry points. Rationale: Listing and Fulfillment are TS, the existing integration test pattern is Vitest, and `supertest` for fulfillment's Express server is straightforward only from TS.

**Sub-steps:**
10.1. Create `tests/e2e/full-pipeline.test.ts` at the repo root. Set up Vitest + MSW + the `INTEGRATION=1` gate.
10.2. Reset fixture state: at the top of the test, truncate the four tables in dependency order (`orders` → `listings` → `design_packages` → `trend_briefs`).
10.3. MSW handlers for Scout (Etsy `listings/active`, Anthropic `/v1/messages`) and Design (Anthropic, fal.ai `/fal-ai/flux-pro/v1.1`).
10.4. Drive Scout: `await execa("python", ["-m", "packages.scout.main"], { env: { ...process.env, NICHE_SEEDS_OVERRIDE: "test-niche" } })`. (Add a `NICHE_SEEDS_OVERRIDE` env hook to `packages/scout/seeds.py` if not already present — small, scoped change.)
10.5. Assert: `trend_briefs` has one row with `niche='test-niche'`, `status='done'`.
10.6. Drive Design: `await execa("python", ["-m", "packages.design.main"])`. Assert `design_packages.status='done'`, `image_url` populated, `mockup_urls` empty (mockups happen in Listing).
10.7. Add `npm run test:e2e` to root `package.json`.

**Files touched:**
- `tests/e2e/full-pipeline.test.ts` (new)
- `packages/scout/seeds.py` (small hook)
- `package.json`

**Verification:** `INTEGRATION=1 npm run test:e2e` green for the Scout→Design portion.

---

## Step 11 — E2E smoke test: Listing→Fulfillment half *(item 7b)*

**Goal:** Extend step 10's test to walk the brief through Listing publishing and Fulfillment receiving an Etsy webhook.

**Sub-steps:**
11.1. Add MSW handlers for Listing (Anthropic, Printify products + publish, Etsy listings POST/PATCH/images) and Fulfillment (Etsy receipts list/get, Printify orders POST, Etsy submit-tracking).
11.2. Drive Listing: import `publishOne` directly and call it on the seeded `design_packages` row. Assert `listings.status='active'`, `etsy_listing_id` set, `printify_product_id` set.
11.3. Drive Fulfillment:
- Spin up the Express server (`packages/fulfillment/src/index.ts`) on a test port.
- POST a fake Etsy webhook payload to `/webhook/etsy-order` with a valid HMAC signature.
- Wait for the order to be processed (poll `orders.status` with a 5s timeout).
- Assert `orders.status` walks `received` → `submitted` → `shipped` (drive the tracking-poller mock to flip to shipped).
11.4. Final assertion block: query all four tables and confirm the final row of each shows the expected end state.

**Files touched:**
- `tests/e2e/full-pipeline.test.ts` (extend)

**Verification:** `INTEGRATION=1 npm run test:e2e` green for the full pipeline.

---

## Step 12 — Design cross-row fal_prompt_hash dedup *(item 4b)*

**Goal:** When a new brief generates the same FLUX prompt as a prior brief, reuse the prior `image_url` instead of paying fal.ai again.

**Sub-steps:**
12.1. Migration `infra/supabase/migrations/006_design_prompt_hash.sql`:
```sql
ALTER TABLE design_packages ADD COLUMN fal_prompt_hash TEXT;
CREATE INDEX idx_design_packages_fal_prompt_hash ON design_packages(fal_prompt_hash);
```
No UNIQUE — repeats are the case we want to detect, not block.
12.2. Update `DesignPackage` in `packages/shared/src/types.ts` and `packages/shared-py/models.py` with `fal_prompt_hash?: string | null`.
12.3. In `packages/design/main.py`, after `build_flux_prompt`:
- Compute `fal_prompt_hash = hashlib.sha256(flux_prompt.prompt.strip().encode()).hexdigest()`.
- Query `design_packages` for any row where `fal_prompt_hash = X` AND `image_url IS NOT NULL` ORDER BY `created_at DESC` LIMIT 1.
- If found: copy `image_url` (and `mockup_urls` if present) into the new row, set `status='done'`, skip fal.ai entirely.
- Always write `fal_prompt_hash` on the row regardless of cache hit/miss.
12.4. Test: seed two trend_briefs whose `build_flux_prompt` outputs match exactly. Run `run()` twice. Assert fal.ai mock got hit exactly once and both `design_packages` rows reference the same `image_url`.

**Files touched:**
- `infra/supabase/migrations/006_design_prompt_hash.sql` (new)
- `packages/shared/src/types.ts`
- `packages/shared-py/models.py`
- `packages/design/main.py`
- `packages/design/test_main.py` (extend)

**Verification:** New unit test passes; the e2e smoke test from steps 10–11 stays green.

---

## Step 13 — Scout semantic dedup via Claude *(item 6)*

**Goal:** Block "cat gifts" → "kitten presents" → "feline tees" from each generating a separate brief.

**Sub-steps:**
13.1. Keep the existing exact-match `is_recent_duplicate` in `packages/scout/dedup.py:7-21` as the fast first filter.
13.2. Add `is_semantic_duplicate(niche: str, db: Client) -> tuple[bool, str | None]`:
- Pull last 50 briefs from the last 7 days (`niche` + `style_keywords`).
- One Claude Sonnet call (`claude-sonnet-4-20250514` per CLAUDE.md). System prompt: "Given a candidate niche and a list of recent niches with their style keywords, return JSON `{is_duplicate: bool, matched_niche: str | null}`. A match means the candidate would produce overlapping designs."
- Use Anthropic prompt caching on the brief list (cacheable section).
- Parse with pydantic. Return `(is_duplicate, matched_niche)`.
13.3. In `packages/scout/main.py:21`, gate insertion on **both** `is_recent_duplicate` (fast) and `is_semantic_duplicate` (slow, only when fast says no). Log `dedup_skip` with `match_reason='exact'` or `'semantic'` and the matched niche.
13.4. Test (`packages/scout/test_dedup.py`):
- Mock the Claude HTTP call with `respx`.
- Fixture A: 5 prior briefs about cats with varied wording. Candidate: "cat lover gifts". Expect `is_duplicate=True`.
- Fixture B: 5 prior briefs about dogs. Candidate: "cat gifts". Expect `is_duplicate=False`.
- Fixture C: empty prior list. Expect `is_duplicate=False` without any Claude call.

**Files touched:**
- `packages/scout/dedup.py`
- `packages/scout/main.py`
- `packages/scout/test_dedup.py` (extend)

**Verification:** Unit tests pass; e2e smoke test from steps 10–11 stays green.

---

## Files this plan will touch (summary)

**TypeScript:**
- `packages/shared/src/etsy-api.ts` (step 7)
- `packages/shared/src/etsy-api.test.ts` *new* (step 7)
- `packages/shared/src/types.ts` (steps 6, 12)
- `packages/listing/src/publisher.ts` (steps 6, 8)
- `packages/listing/src/publisher.test.ts` *new or extend* (steps 6, 8)
- `packages/listing/tests/integration/publisher-flow.test.ts` *new* (step 9)
- `tests/e2e/full-pipeline.test.ts` *new* (steps 10, 11)
- Per-package `package.json`s (step 4)
- Root `package.json` (steps 4, 10)
- `.eslintrc.cjs` *new* (step 4)

**Python:**
- `packages/shared-py/notifier.py` *new* (step 2)
- `packages/shared-py/test_notifier.py` *new* (step 2)
- `packages/shared-py/models.py` (steps 6, 12)
- `packages/scout/main.py` (steps 3, 13)
- `packages/scout/dedup.py` (step 13)
- `packages/scout/seeds.py` (step 10 — small env-override hook)
- `packages/scout/test_main.py` *new or extend* (step 3)
- `packages/scout/test_dedup.py` *extend* (step 13)
- `packages/design/main.py` (steps 1, 3, 12)
- `packages/design/test_main.py` *new or extend* (steps 1, 3, 12)
- `pyproject.toml` *new* (step 4)
- `packages/{scout,design,shared-py}/requirements-dev.txt` (step 4)

**Infra:**
- `infra/supabase/migrations/005_listings_printify_product_id.sql` *new* (step 6)
- `infra/supabase/migrations/006_design_prompt_hash.sql` *new* (step 12)
- `.github/workflows/ci.yml` *new* (step 5)

---

## Verification matrix (end-of-plan smoke check)

After all 13 steps land, run in order:

1. `npm run lint && npm run typecheck && npm run test:ts` — TS gate.
2. `ruff check . && pyright && pytest packages/scout packages/design packages/shared-py` — Python gate.
3. `supabase start && npx supabase db reset` — migrations apply cleanly from scratch.
4. `INTEGRATION=1 npm test --workspace=packages/listing` — listing integration test.
5. `INTEGRATION=1 npm run test:e2e` — full pipeline.
6. CI on a clean push to a PR — green.

If all six pass, v1 is mock-complete. The remaining work to ship is:
- Etsy storefront re-application + reapproval (out of scope here).
- Flip `HUMAN_REVIEW_ENABLED` to false (config change).
- Smoke-test against real Etsy/Printify/fal.ai in a sandbox shop before going live.

---

## Out of scope

- v1.5 / v2.0 roadmap items (Tier 3 in V1_AND_BEYOND.md).
- `integration.yml` and `codeql.yml` CI workflows.
- Cron simulations in CI.
- Live API tests anywhere.
- Branch protection UI configuration (manual follow-up after step 5).
