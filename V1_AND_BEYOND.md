# V1_AND_BEYOND.md — Where we are, what to ship before v1, what's worth doing while Etsy is gated

## Context

Etsy API access was **denied**. The next step is setting up a storefront so Etsy can see we're a real seller, then re-applying. That's a calendar problem, not a code problem.

While that's pending, this doc inventories the codebase and prioritizes what's worth doing **right now** — either (a) blockers that must be finished before v1 can ship at all, or (b) hardening with serious ROI for v1 even before Etsy access lands.

The user's existing v1.1/v1.5/v2.0 roadmap is acknowledged below but mostly **out of scope** here. This doc focuses on items where the next dollar of effort goes the furthest given today's blockers.

---

## State of the build (snapshot, 2026-05-09)

| Agent / area | State | Notes |
|---|---|---|
| `packages/shared/` (TS) | ✅ Done | config, db, logger, types, **etsy-tokens (Supabase)**, **etsy-auth (refresh)**, etsy-api wrappers, notifier — all tested |
| `packages/shared-py/` | ✅ Done | mirrors TS |
| `packages/scout/` | ✅ Done | 3–5 briefs/run, exact-niche dedup over 7 days, retries, rate-limited |
| `packages/design/` | ✅ Done | claim RPC w/ `FOR UPDATE SKIP LOCKED`, Pillow 300dpi pipeline, Printify mockup write-back |
| `packages/fulfillment/` | ✅ Done | HMAC verify + replay window, idempotent inserts, receipt poller fallback, tracking poller, Slack alerts |
| `infra/supabase/migrations/` 001–004 | ✅ Done | tables, indexes, triggers, claim RPCs |
| `packages/listing/` | ⚠️ ~70% | pricing floor, copywriter, Printify product create — all built and tested. **Etsy publish flow is a TODO stub.** |
| `.github/workflows/` | ❌ Missing | no CI at all |
| Design fal.ai cache | ❌ Missing | re-runs on the same trend brief regenerate at $0.05/image |
| Scout semantic dedup | ⚠️ Exact-match only | "cat gifts" and "kitten presents" both pass through |
| Scout/Design Slack alerts on fatal error | ❌ Missing | only Fulfillment alerts; Scout/Design fail silently |

The Etsy denial is *not* the limiting factor for most of the gaps above. The Listing publish flow can be built and tested against mocks today; flipping it on becomes a config flip once access lands.

---

## Item list — what to address, in priority order

### Tier 1 — Pre-v1 blockers (must finish for v1 to exist as a working pipeline)

1. **Listing → Etsy publish flow** *(double-stubbed)*
2. **Listing end-to-end integration test**
3. **Minimum CI (lint + typecheck + unit)**

### Tier 2 — High-ROI hardening to do while Etsy is gated

4. **Design Agent fal.ai image cache / generation dedup**
5. **Scout + Design fatal-error Slack alerting**
6. **Scout semantic dedup** (upgrade from exact-niche match)
7. **End-to-end mocked pipeline smoke test**

### Tier 3 — Explicitly deferred (not in this doc)

These are real, but every one of them is more valuable *after* the pipeline is proven. Listed here so the line is drawn clearly:

- v1.5 Scout custom niche searches (manual steering)
- v1.5 Design Agent original-input mode (your ideas, not the robot's)
- v2.0 Listing more product types (mugs, posters)
- v2.0 Design image size and placement tweaking
- v2.0 Dashboard
- v1.1 "Etsy Supabase token storage" — **already done** (`packages/shared/src/etsy-tokens.ts` + `etsy-auth.ts`); strike from roadmap

---

## Tier 1 — Pre-v1 blockers

### 1. Listing → Etsy publish flow

**Why:** The publisher today walks through pricing → copy → Printify product create → mockup write-back, then **stops** at status `pending_publish` with a TODO comment. No listing ever reaches `active` status. Until this is wired, the system can never put anything on Etsy — it's the literal hole in the v1 pipeline.

The stub is two layers deep:

- `packages/shared/src/etsy-api.ts:115-132` — `createDraftListing`, `uploadListingImage`, and `activateListing` all throw `"not yet implemented"`.
- `packages/listing/src/publisher.ts:78-91` — the path after `pending_publish` is a `void productId; void setProductVisible;` placeholder. `resumePublish` at line 127 is empty.

**What Sonnet should do (when the time comes):**

- Implement the three wrappers in `shared/src/etsy-api.ts` against the Etsy v3 endpoints listed in CLAUDE.md (`POST /application/shops/{shop_id}/listings`, `POST .../listings/{id}/images`, `PATCH .../listings/{id}` with `state: "active"`). Reuse the existing `etsyFetch` helper — it already handles token refresh and rate limiting, so the wrappers are thin.
- Reuse the Zod-validated response parsing pattern already used in `getReceipt` / `listReceipts`.
- In `publisher.ts`, replace the TODO at line 81 with: call `createDraftListing`, loop over `mockupUrls` calling `uploadListingImage`, call `activateListing`, then `setProductVisible` (already imported, line 4). Update the row to `status='active'`, `is_active=true`, `etsy_listing_id=<returned id>`.
- Implement `resumePublish` (line 127) as the same flow minus the steps already done — start at draft create using the existing `listings` row's title/description/tags/price.
- Mock all three Etsy endpoints with MSW so this can land *before* Etsy access does. The integration switches on with a one-line config change.

**Cost:** ~2–3 hours including tests.

---

### 2. Listing end-to-end integration test

**Why:** The pricing and copywriter unit tests are solid, but there is no test that walks a `design_packages` row all the way to `listings.status='active'`. Without it, item 1 will land untested at the seam where most bugs hide (between Printify create and Etsy upload). The fulfillment package already has a `webhook-flow.test.ts` integration pattern to copy from.

**What Sonnet should do:** Add `packages/listing/src/publisher.integration.test.ts`:

- Real local Supabase (per the CLAUDE.md testing rules — never mock the DB).
- MSW handlers for `api.printify.com` (product create, visibility flip) and `openapi.etsy.com` (the three wrappers from item 1).
- Seed a `trend_briefs` + `design_packages` row, call `publishOne`, assert: `listings` row reaches `active`, `is_active=true`, `etsy_listing_id` populated, Printify visibility flipped, mockup URLs written back to `design_packages`.
- Cover the `HUMAN_REVIEW_ENABLED=true` path separately: assert the row stops at `needs_review` and `resumePublish` picks it up correctly.
- Add the failure-path test: Etsy `activateListing` returns 500 → row flips to `pending` with `retry_count=1` (under 3) and `error` (at 3).

**Cost:** ~1–2 hours, depends on existing MSW handler reuse.

---

### 3. Minimum CI (lint + typecheck + unit tests)

**Why:** No `.github/workflows/` exists. CLAUDE.md treats this as a required quality gate before merging to `main`. Without it, items 1 and 2 can land broken and nobody notices until the next manual run. This is cheap to add and pays back the first time anyone pushes a typo.

**What Sonnet should do:** Add a single `.github/workflows/ci.yml` that runs on PR and push-to-main:

- One job for TS: `npm ci` → `npm run lint` → `npm run typecheck` → `npm test` (across `packages/listing`, `packages/fulfillment`, `packages/shared`). Use `actions/setup-node@v4` with `cache: 'npm'`.
- One job for Python: `pip install -r requirements-dev.txt` per package → `ruff check` → `pyright` (or `mypy`) → `pytest` (across `packages/scout`, `packages/design`, `packages/shared-py`). Use `actions/setup-python@v5` with `cache: 'pip'`.
- Use `paths:` filters so TS changes don't trigger Python jobs and vice versa, with `packages/shared/**`, `packages/shared-py/**`, and `infra/supabase/migrations/**` triggering both.
- Skip `integration.yml` and `codeql.yml` for now — they're nice-to-have, the unit gate is the survival floor. Add them once v1 is live.

**Cost:** ~1 hour.

---

## Tier 2 — High-ROI hardening (do while Etsy is gated)

### 4. Design Agent fal.ai image cache / generation dedup

**Why:** Each fal.ai call costs ~$0.05. The Design Agent's only protection against re-generating an image is the 1:1 link from `trend_briefs → design_packages`. If a `design_packages` row hits `error` and is retried (the `retry_count<3` path does this on every retryable failure), Sonnet will currently call fal.ai again — re-burning credits for an image we already paid for. Worse, Scout's exact-match dedup will let near-duplicate niches through, and each one costs another $0.05. This is real money walking out the door at any non-trivial scale.

**What Sonnet should do:**

- Compute a stable hash from the FLUX prompt (already stored in `design_packages.fal_prompt`). SHA-256 of the trimmed prompt is fine.
- Add a `fal_prompt_hash` column to `design_packages` (new migration `005_*.sql`) with a unique index.
- In `packages/design/main.py`, before calling `fal_client.run`, query `design_packages` for any prior row with the same `fal_prompt_hash` whose `image_url` is non-null. If found, copy the `image_url` and `mockup_urls` (when present) into the new row instead of regenerating.
- Separately, on retry, check whether *this same row* already has `image_url` populated (i.e., the failure happened *after* fal.ai succeeded but before Storage upload completed). If yes, skip fal.ai entirely on the retry. This is the simpler, cheaper win and should land first.
- Add a unit test that re-runs `processOne` against a row with `image_url` set and asserts zero fal.ai calls.

**Cost:** ~2–3 hours including the migration. The cross-row dedup is more involved than the same-row retry guard; consider shipping the same-row guard first and adding cross-row dedup as a follow-up.

---

### 5. Scout + Design fatal-error Slack alerting

**Why:** Fulfillment fires a Slack alert when an order hits the 3-retry ceiling. Scout and Design only log. That means a niche that consistently fails Etsy fetches, or a fal.ai outage that burns the retry budget on every brief, is silently piling up `error` rows in Supabase and the user has no idea unless they're staring at the dashboard (which doesn't exist yet). At v1 scale this is a "wake up to 30 broken rows" failure mode.

**What Sonnet should do:**

- The `notify_slack` helper already exists in `packages/shared/src/notifier.ts` (TS) and should be mirrored in `packages/shared-py/notifier.py` (verify it exists; if not, port it — it's ~30 lines).
- In `packages/scout/main.py`, in the error path where `retry_count >= 3`, call `notify_slack` with a structured message: `agent`, `record_id`, `niche`, `error_message`, last 200 chars of stack.
- Same in `packages/design/main.py` for both fal.ai failures and Storage failures at the 3-retry ceiling.
- Catch and log any failure inside `notify_slack` itself — alerts must never throw and crash the agent. The TS implementation already does this; mirror that.
- Add a unit test that asserts Slack is called exactly once per row that hits the ceiling, and zero times during retryable failures.

**Cost:** ~1–2 hours.

---

### 6. Scout semantic dedup

**Why:** Today's dedup in `packages/scout/dedup.py` is `WHERE niche = $1 AND created_at > now() - interval '7 days'`. That blocks "minimalist cat shirts" → "minimalist cat shirts" but lets "cat gifts" → "kitten presents" → "feline tees" all through. Each duplicate niche feeds Design, which generates a near-duplicate image, which costs $0.05. Tier 2 because the cost is real but bounded — the same-row retry guard in item 4 is the bigger lever. Worth doing here because the user listed "Scout fuzzy matching" in v1.5 specifically as a credit-saver, and we already have Claude calls running in this agent so the marginal infrastructure cost is near zero.

**What Sonnet should do:**

- In `packages/scout/dedup.py`, add a second check after the exact-match query: pull the niches and `style_keywords` from the last 7 days of `trend_briefs`, and ask Claude Sonnet (one batched call, with prompt caching on the prior briefs) "is the candidate niche semantically equivalent to any of these?" Return yes/no plus the matching brief id.
- Cap the comparison at the 50 most recent briefs to keep the prompt bounded.
- Treat a positive match the same way as the exact-match path: skip insertion, log "deduped".
- Test with a fixture: 5 prior briefs about cats with different wording, candidate is "cat lover gifts" → expect `is_recent_duplicate=True`.

**Cost:** ~2 hours. Could be deferred behind item 4 if budget is tight, but it pairs naturally with the alerting in item 5 and reuses the same Claude infrastructure.

---

### 7. End-to-end mocked pipeline smoke test

**Why:** Each agent has its own tests, but there is no test that walks a single trend brief from "Scout discovers it" → "Design generates" → "Listing publishes" → "Fulfillment receives webhook" → "tracking posted to Etsy". When item 1 lands, the seams between agents become the most likely place for v1 to break in production. A single smoke test catches the integration regressions that per-agent tests miss by definition.

**What Sonnet should do:**

- Create `tests/e2e/full-pipeline.test.ts` (or `.py`, depending on which runner is easier — TS is probably simpler since fulfillment and listing are TS).
- Spin up local Supabase via `supabase start`.
- MSW handlers for: Etsy listings active, Anthropic, fal.ai, Printify (catalog, products, orders), Etsy listings POST/PATCH/images, Etsy receipts.
- Drive the four agents in sequence by calling their entry points directly (not subprocess) — this is the cheapest way to test the contracts.
- Final assertions: `trend_briefs.status='done'`, `design_packages.status='done'` and `image_url` set, `listings.status='active'` and `etsy_listing_id` set, `orders.status='shipped'` after firing a fake webhook.
- Gate behind `INTEGRATION=1` so it doesn't run on every push.

**Cost:** ~3–4 hours. Heaviest item in the doc, but it's the one that proves v1 is real.

---

## Recommended sequencing

The Etsy denial gives a window. Here's the order that makes the most sense:

1. **Item 4 (same-row retry guard, half of it).** ~30 minutes. Stops bleeding fal.ai credits on retries, today.
2. **Item 5 (Scout/Design Slack alerts).** ~1–2 hours. Now you stop missing failures. Compounds with everything below.
3. **Item 3 (CI).** ~1 hour. Now every change after this is gated.
4. **Item 1 (Listing publish flow, mocked).** ~2–3 hours. Wires the pipeline end-to-end against MSW, even with no Etsy access.
5. **Item 2 (Listing integration test).** ~1–2 hours. Validates item 1.
6. **Item 7 (full-pipeline smoke test).** ~3–4 hours. Covers item 1's seams with the other agents.
7. **Item 4 (cross-row fal.ai cache).** ~1–2 hours. The harder half of item 4, after the rest is stable.
8. **Item 6 (Scout semantic dedup).** ~2 hours. Last because it's an optimization on top of a working pipeline.

Total estimated work: **~12–17 hours** of focused implementation. Likely a long weekend. Done while waiting for the storefront → Etsy reapproval cycle.

---

## Files this plan would touch

- `packages/shared/src/etsy-api.ts` — fill in `createDraftListing`, `uploadListingImage`, `activateListing`
- `packages/listing/src/publisher.ts` — wire the Etsy publish flow at lines 78–91 and 127–132
- `packages/listing/src/publisher.integration.test.ts` — new
- `packages/design/main.py` — add same-row retry guard around fal.ai call
- `packages/design/poller.py` — possibly add cross-row hash lookup (item 4 part 2)
- `infra/supabase/migrations/005_design_dedup.sql` — new migration for `fal_prompt_hash`
- `packages/scout/main.py` + `packages/design/main.py` — wire `notify_slack` in error-ceiling paths
- `packages/shared-py/notifier.py` — verify exists; port from TS if not
- `packages/scout/dedup.py` — add semantic dedup via Claude Sonnet
- `.github/workflows/ci.yml` — new
- `tests/e2e/full-pipeline.test.ts` — new

---

## Verification

- **Item 1:** unit + integration tests pass; manually run `npm start --workspace=packages/listing` against a seeded `design_packages` row with MSW intercepting Etsy → assert `listings.status='active'` and Printify visibility flipped.
- **Item 2:** `INTEGRATION=1 npm test --workspace=packages/listing` runs green against `supabase start`.
- **Item 3:** push a typo branch and confirm CI fails on the right step.
- **Item 4:** run Design twice in a row against the same trend brief → assert exactly one fal.ai call (in network log).
- **Item 5:** force a retry-ceiling failure in Scout and Design → confirm a Slack post appears, with the row id.
- **Item 6:** seed five "cat-themed" briefs, run Scout → assert 1 brief inserted, 4 deduped.
- **Item 7:** `INTEGRATION=1 npm test tests/e2e/` runs green; the four assertions on the four tables all pass.
