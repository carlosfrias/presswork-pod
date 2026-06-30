# Bug Fix & Feature Plan — Scout JSON, Listing quantity, Listing publish UX + image swap

_Status: proposed — awaiting your approval before any code changes. Plan approval ≠ execution approval._

This plan covers the three issues raised: (1) Scout "Run" produces error rows instead of review-queue
briefs, (2) Listing publish fails with `Etsy 400: Missing input parameter: [quantity]`, and (3) Listing
publish UX (one-at-a-time, cost-aware) plus a new image-management/swap panel.

---

## Issue 1 — Scout: fenced JSON → error rows, nothing in review queue

### What's actually happening
- Claude wrapped its analysis in a ```` ```json … ``` ```` Markdown fence. The Scout analyzer called
  `json.loads(raw_text)` directly, which threw, and the error was re-raised as
  `Claude returned invalid JSON: '```json…'`.
- Scout's `main.py` catches that and **intentionally** writes a `status='error'` row to `trend_briefs`
  with the message — that's why you see them in **All briefs** but not the review queue. The review
  queue only shows `status='needs_review'`. So those error rows are **working as designed** for
  observability + the 7-day dedup backoff. **We are not changing that.**
- The fence-stripping fix already landed in commit `0ddcbd8` (`_strip_code_fences`). You ran Scout
  **before that commit was saved**, so the rows you're seeing are stale artifacts from the old code.

### Why "are we talking to Claude for those / should it be saved to DB?"
Yes — Claude is the analyzer step (raw Etsy listings → structured `TrendBrief`). Persisting the failure
as an `error` row is deliberate: it surfaces what failed and feeds the 7-day duplicate-niche backoff so
Scout doesn't hammer the same niche nightly. Keep it.

### Remaining real gap (worth fixing)
`_strip_code_fences` (`packages/scout/analyzer.py:13-28`) only strips when the response **starts with** a
fence. If Claude adds a prose preamble ("Here is the JSON:\n```json…"), it still fails.

### Changes
1. `packages/scout/analyzer.py:13-28` — replace `_strip_code_fences` with a regex extractor that pulls the
   first ```` ``` ```` / ```` ```json ```` block regardless of position (preamble/trailing prose), and
   falls back to the stripped text when no fence is found.
2. `packages/scout/test_analyzer.py` — add a prose-preamble test alongside the existing fenced-JSON test.
3. `packages/scout/analyzer.py:39-50` (SYSTEM_PROMPT) — add an explicit "Do not wrap the JSON in code
   fences or add commentary" line to reduce how often the fallback path is exercised. _(Optional — your call.)_

### Decisions for you
- **Stale error rows** (e.g. "retirement gifts"): they block re-scouting those niches for 7 days via dedup.
  Want me to clear `status='error'` rows now so the next run re-picks them? (Cloud Supabase per project rule.)
- A fresh Run on current `main` should now produce `needs_review` rows — worth re-running to confirm.

**Effort:** small. No migration. **Risk:** very low.

---

## Issue 2 — Listing: `Etsy 400: Missing input parameter: [quantity]`

### What's actually happening
Current `main` is **already correct** — `packages/shared/src/etsy-inventory.ts:92` sends
`quantity: POD_VARIANT_QUANTITY` (999) on every offering, and `inventory.test.ts` asserts it. The 400 came
from running a **stale `@presswork/shared` dist**: `dist/` is gitignored and the inventory PUT path was
added in commit `85de823`. If the dist wasn't rebuilt after that commit, the listing agent ran old code
without the `quantity` field.

### Changes
1. **Operational (immediate):** `npm run build --workspace packages/shared`, then confirm
   `packages/shared/dist/etsy-inventory.js` contains `quantity`. This is what unblocks your next publish.
2. **Test hardening (so this can't silently regress):**
   - Add an MSW handler for `PUT /v3/application/listings/{id}/inventory` in
     `packages/listing/tests/integration/publisher-flow.test.ts` that 400s if any offering lacks a numeric
     `quantity` (today `onUnhandledRequest: "warn"` lets it pass through unvalidated).
   - Add a regression unit test in `inventory.test.ts` asserting `quantity === 999` and a Zod round-trip
     via `EtsyInventoryInputSchema.parse(...)`.
3. **Hardening (optional):** tighten `EtsyOfferingSchema.quantity` from `.nonnegative()` to `.positive()`
   (Etsy rejects 0 anyway), and assert `quantity > 0` in the mock fixture so mock-mode catches regressions.

### Decisions for you
- Was the 400 local or on **Railway**? If Railway, its build step may not run
  `npm run build --workspace packages/shared` before starting the listing service — we should fix the build
  config too. (Open question — let me know where you hit it.)

**Effort:** small. No migration. **Risk:** low.

---

## Issue 3 — Listing publish UX (one-at-a-time, cost-aware) + image swap panel

### What's actually happening
- The **"Run Listing"** button spawns the full listing agent subprocess, whose loop publishes **every**
  `pending_publish` row in sequence — each costing the $0.20 Etsy fee. No per-listing control, no cost prompt.
- The detail-page **"Approve & publish"** button is mislabeled: `approveListing` only flips status to
  `pending_publish`. Nothing publishes until the agent runs.
- Images: the design PNG + `design_packages.mockup_urls` are what's available locally; on publish only the
  **mockup_urls** are uploaded to Etsy (rank-ordered). There is **no UI** to see which images are live on
  the Etsy listing or to swap them. Etsy is the source of truth (no local `etsy_images` column).

### Part A — Per-listing, cost-aware publish
1. Relabel detail-page "Approve & publish" → **"Approve"** (accurate: it only queues).
2. Add a **"Publish to Etsy ($0.20 listing fee)"** button shown only when `status='pending_publish'`, with a
   confirmation (reuse the existing `<details>` popover pattern — no new deps). It calls a new
   `publishListingNow` server action that: asserts owner → re-checks `status='pending_publish'` (stale-tab
   guard) → calls `resumePublish` → revalidates. Disable it when any listing is in `publishing` (reuse the
   existing agent-running lock).
3. Keep the batch "Run Listing" button (legit batch use); update the list-page subtitle to make the
   per-listing + cost path explicit.

**Key architectural decision:** `resumePublish` currently lives in `packages/listing/src/publisher.ts`, and
the dashboard only imports from `@presswork/shared`. Cleanest path: **move `resumePublish` (and its publish
helpers) into `@presswork/shared`** so the dashboard can call it directly. Also requires the dashboard's
Railway env group to include the listing agent's env vars (`ETSY_PRODUCTION_PARTNER_ID`,
`ETSY_SHIPPING_PROFILE_ID`, `ETSY_READINESS_STATE_ID`, etc.). Compliance gates in `executeEtsyPublish` stay.

### Part B — Image management / swap panel
New Etsy client functions in `packages/shared/src/etsy-api.ts`:
- `getListingImages(db, listingId)` — expand the existing images schema to return
  `{ listing_image_id, rank, url_570xN, alt_text }[]` (today `getListingImageCount` discards everything but
  the count; the expansion is additive and backwards-compatible).
- `deleteListingImage(db, listingId, imageId)` — `DELETE …/listings/{id}/images/{image_id}`.
- (Upload already exists: `uploadListingImage`.)

New mock fixtures in `etsy-mock.ts`: a DELETE fixture + populated `list_listing_images` results.

New dashboard REST routes under `app/api/listings/[id]/etsy-images/` (follow the existing `etsy-preview`
route pattern): `GET` (live Etsy images), `POST` (upload one from the pool by URL+rank), `DELETE` (by image id).

New client component `EtsyImagePanel.tsx`, shown when `status='active'` and `etsy_listing_id` is set:
- **Live on Etsy** — fetched on demand (expand-to-load, to spare the rate budget); each image shows rank +
  Delete.
- **Available images** — design PNG + all `mockup_urls`; each has "Add to Etsy".
- v1 scope suggestion: **add + delete only** (rank appended). Reorder requires delete-then-repost, which
  briefly disrupts the live listing.

**No DB columns/migration needed** — Etsy is the source of truth; the local pool comes from the already-fetched
`design_packages`.

### Decisions for you
1. **Move `resumePublish` into `@presswork/shared`** (recommended) vs. keep publish CLI-only and have the
   dashboard just queue? This is the main design fork for Part A.
2. Image panel v1: **add/delete only** (simple, safe) vs. include **reorder** (delete+repost, disruptive)?
3. Should the raw **design PNG** be uploadable to Etsy as a listing image (today only mockups are)?
4. Load live Etsy images **on panel-expand** (recommended, saves rate budget) vs. on every detail render?

**Effort:** Part A small–medium (the `resumePublish` move is the bulk); Part B medium. No migration.
**Risk:** medium — touches the live Etsy publish path; mock mode + compliance gates mitigate.

---

## Suggested execution order
1. **Issue 2 operational fix** (`npm run build --workspace packages/shared`) — unblocks publishing now.
2. **Issue 1** Scout regex + test (+ optional prompt line; optional clear stale rows).
3. **Issue 2** test hardening (MSW handler + regression unit test).
4. **Issue 3 Part A** — relabel + per-listing publish button + `resumePublish` relocation.
5. **Issue 3 Part B** — Etsy image client fns + mock fixtures + API routes + panel.

Each step is independently shippable. I'll write tests alongside (Vitest/MSW for TS, pytest/respx for Python)
and not skip the status-transition / compliance coverage the project requires.
