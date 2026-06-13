# AUDIT_5 — Full-repo code audit (2026-06-11)

Findings from a full-repo audit: Listing/Ledger/Scout/Design agents, shared libs
(etsy-api, etsy-auth, etsy-compliance, printify-http, config, notifier, llm-usage),
dashboard (auth, middleware, server actions), and key migrations (031, 034, 044,
046/048, 057). Line numbers are accurate as of commit `daf65f5`.

Each item is self-contained — problem, repro path, suggested fix, verification —
so it can be picked up individually in a fresh session by any model.

Status legend: `[ ]` open · `[x]` done · `[-]` won't fix

---

## HIGH

### [x] H1 — Listing queue starvation from a `pending` row with null `design_package_id`

**Where:** `packages/listing/src/index.ts:39-53` (`fetchPendingListing`), plus the missing
guard in `packages/dashboard/lib/actions/listings.ts` (`retryListing`, ~line 826).

**Problem:** `fetchPendingListing` fetches the single oldest `status='pending'` listings row
(`order(created_at).limit(1)`) and returns `null` when its `design_package_id` is null. The
row is never marked `error`, so it stays the head of the queue forever. Effect on `run()`:
Phase 2 is permanently skipped, Phase 3 keeps claiming approved designs into new `pending`
rows that are never processed, then the run exits. The whole listing pipeline is dead until
the row is manually fixed.

**Realistic repro path:** `rejectListing` with "send design back" sets `status='error'` AND
nulls `design_package_id` (`listings.ts:232`). The Errors card then offers Retry;
`retryListing` has no guard and sets `status='pending'` → pending row with null FK.

**Fix:**
1. In `fetchPendingListing`, when the oldest pending row has a null `design_package_id`,
   update it to `status='error'` with an explanatory `error_message` and continue to the
   next pending row (don't return null).
2. Add a guard to `retryListing`: only allow retry from `error`, and refuse (with a clear
   message) when `design_package_id` is null.

**Verify:** unit test — seed a pending row with null FK + a claimable approved design;
`run()` must error-park the bad row and still publish the claimed design.

---

### [x] H2 — Missing status guards on three dashboard listing actions (illegal transitions)

**Where:** `packages/dashboard/lib/actions/listings.ts` — `regenerateCopy` (~line 718),
`recreatePrintifyProduct` (~737), `retryListing` (~826).

**Problem:** All three update unconditionally by id — no pre-read status check and no
`.in("status", ...)` filter on the UPDATE, unlike every other action in the file
(`approveListing`, `rejectListing`, `updateListingCopy` all have both). Fired against an
`active` listing (stale tab, double click), `regenerateCopy` nulls the live listing's
title/description/tags and demotes `active → pending` — an illegal transition that the
CHECK constraint (migration 034) cannot catch because it validates values, not transitions.
`recreatePrintifyProduct` from `active` nulls `printify_product_id` and re-queues a row whose
publish then fails repeatedly on publishOne's `is_active` guard until it parks at `error`.

**Fix:** mirror the `approveListing` pattern: pre-read the row, throw on disallowed source
statuses, and repeat the status filter on the UPDATE as the optimistic-concurrency guard.
Legal sources: `regenerateCopy` ← {needs_review, error}; `recreatePrintifyProduct` ←
{needs_review, error}; `retryListing` ← {error} (and non-null `design_package_id`, see H1).

---

### [x] H3 — Etsy refresh-token rotation can permanently brick OAuth

**Where:** `packages/shared/src/etsy-auth.ts` (single-flight at line 32, `doRefresh` at
60-118), `packages/shared/src/etsy-tokens.ts:38-44`.

**Problem (two parts):**
1. **Cross-process refresh race.** The `pendingRefresh` coalescing is per-process only. Etsy
   rotates the refresh token on every use. The Listing CLI, the dashboard process (which
   runs `resumePublish` via `publishListingNow`), and Ledger can run concurrently — two
   parallel refresh POSTs mean one process persists a dead refresh token → `invalid_grant`
   → manual re-authorization required.
2. **Lost rotation on write failure.** In `doRefresh`, if `setEtsyTokens` throws *after* the
   Etsy POST succeeded, the rotated refresh token exists only in process memory and is lost.
   A transient DB blip permanently kills the grant.

**Fix:**
1. Serialize refresh across processes — take a Postgres advisory lock
   (`pg_advisory_xact_lock`) around read-check-refresh-write via an RPC; after acquiring
   the lock, re-read the config row and skip the POST if another process already refreshed
   (token no longer near expiry).
2. On `setEtsyTokens` failure after a successful refresh, retry the write a few times and
   fire a CRITICAL Slack alert (`notifySlack`, severity error) saying manual re-auth will
   be required — don't just throw.

---

### [x] H4 — Unchecked supabase write results at critical publisher checkpoints

**Where:** `packages/listing/src/publisher.ts`. supabase-js returns `{ error }` instead of
throwing; nearly every `await db.from("listings").update(...)` in this file drops it.

**Worst cases:**
- **~443-446** — persisting `etsy_listing_id` immediately after `createDraftListing`.
  Silent failure → resume path reads null → POSTs a **second Etsy draft** (duplicate $0.20
  fee, orphaned draft).
- **~503-506** — the `status='active', is_active=true` write right after `activateListing`.
  Silent failure → **live, buyable Etsy listing** whose DB row says `publishing` — the exact
  unreconcilable state the comment above it says must never exist. The watchdog flags it
  after 60 min but nothing repairs it.
- **Error-path writes** (~332-340 in `publishOne` catch, ~657-666 in `resumePublish` catch)
  — if the `status='error'/'pending'` write fails, the row is stuck at
  `processing`/`publishing` with no alert; the original error survives only in the log.
- Same pattern on the step-3/4 copy + mockup writes (~170-192, ~270-290) and the
  `needs_review` pause (~295-298) — lower stakes (next run self-heals) but same hygiene.

**Fix:** add a small helper in publisher.ts, e.g.
`async function mustWrite(q, ctx) { const { error } = await q; if (error) throw new PublisherError(\`${ctx}: ${error.message}\`); }`
and use it at the two critical checkpoints. For the catch-path writes (where throwing would
mask the original error), log + `notifySlack` on failure instead — copy the pattern from
`packages/design/main.py`'s error handler, where each secondary DB write is individually
guarded so the alert always fires.

---

## MEDIUM

### [x] M1 — Pricing floor not re-validated at the publish chokepoint

**Where:** `packages/listing/src/publisher.ts` — `executeEtsyPublish` (~397-400) and
`resumePublish` (~641, passes `listing.price_usd ?? 0`).

**Problem:** `executeEtsyPublish` re-runs the partner/mockup/copy gates but NOT
`validatePricingFloor`, even though CLAUDE.md says the publish step re-runs the full
compliance gate (pricing floor is non-negotiable rule #3). Today the guarded edit actions
make a below-floor price unlikely, but the chokepoint exists precisely to not trust
upstream. A literal `0` is caught by the zod `price: positive()` on draft create, but e.g.
$15 would publish.

**Fix:** call `validatePricingFloor(priceUsd, printCostForBlueprint)` inside
`executeEtsyPublish` next to the other gates. Coordinate with M2 for where the print cost
comes from.

---

### [x] M2 — Print-cost / pricing constants duplicated and blueprint-blind

**Where:**
- `packages/dashboard/lib/actions/listings.ts:8` — `PRINT_COST_USD = 10.09` (comment admits
  it "mirrors" the listing constant).
- `packages/listing/src/constants.ts:12` — `GILDAN_64000_PRINT_COST_USD = 10.09`.
- `packages/ledger/src/constants.ts` — a separate `BLUEPRINT_PRINT_COST_USD` map.
- `packages/listing/src/publisher.ts:149` — `validatePricingFloor(priceUsd,
  GILDAN_64000_PRINT_COST_USD)` always uses the Gildan cost even though the blueprint id is
  parameterized two lines earlier (`defaultEtsyPriceUsd(design.printify_blueprint_id ?? 145)`).

**Problem:** three independent copies of the same economic fact. The moment a second
blueprint ships, the publisher floor check and the dashboard floor are silently wrong for it.

**Fix:** one shared per-blueprint print-cost map in `@presswork/shared` (the Ledger's
`BLUEPRINT_PRINT_COST_USD` is the right shape — move it there and re-export), consumed by
the publisher floor check, the dashboard floor check, and Ledger economics. Make the floor
validation take the blueprint-resolved cost.

---

### [ ] M3 — Receipt poller has no pagination; can permanently miss orders

**Where:** `packages/ledger/src/receipt-poller.ts:36-39`; `listReceipts` in
`packages/shared/src/etsy-api.ts:146` already supports `offset`.

**Problem:** one page of `limit: RECEIPT_POLL_PAGE_LIMIT` (100) per run, never pages. Runs
are manual today, so long gaps are the norm — a backlog of >100 new paid receipts between
runs silently drops the oldest ones forever (the UNIQUE-constraint dedup makes re-scans
safe, but nothing ever fetches past the first page).

**Fix:** loop with increasing `offset` until a page returns fewer than the limit (or until a
full page of duplicates is seen, as a cheap early-exit). Keep a max-pages ceiling like
`getActiveEtsyListings` does (`etsy-api.ts:607`).

---

### [ ] M4 — One bad row crashes the whole Listing run (fetch helpers outside try)

**Where:** `packages/listing/src/index.ts:95-96`.

**Problem:** `fetchDesign` / `fetchTrendBrief` throw OUTSIDE the per-listing try/catch, so a
missing or corrupt FK kills the entire drain loop: process exits, everything behind the bad
row is starved, no `status='error'` written, no alert (only the top-level `run().catch`
console.error). Also `design.trend_brief_id ?? ""` (line 96) masks a null FK behind a
misleading "trend_brief  not found" error.

**Fix:** move the two fetches inside the try; on failure, write `status='error'` +
`error_message` to the listings row (using the H4 helper) and `continue`. Handle null
`trend_brief_id` explicitly with a precise message.

---

### [ ] M5 — `spawnAgentForOperatorAction` is an exported server action without an auth check

**Where:** `packages/dashboard/lib/actions/triggers.ts:127-132`.

**Problem:** in a `"use server"` module every exported async function becomes a POST-able
endpoint. This one deliberately skips `requireOwnerEmail` ("callers must"). Today only the
middleware protects it (installed Next 15.5.18 is patched against the middleware-bypass
CVE-2025-29927, so not currently exploitable) — but it breaks the repo convention of
auth-in-every-action and is one framework regression away from being a hole.

**Fix:** either move the unauthenticated internal helper into a non-`"use server"` module
and export only authed wrappers, or simply add `requireOwnerEmail` to it (all callers are
already in authed contexts, so the extra check is harmless).

---

### [ ] M6 — `retry_count` increments are read-then-write (race-prone)

**Where:** `packages/listing/src/publisher.ts` — `publishOne` catch (~311-335) re-reads
`retry_count` then writes `+1`; `resumePublish` catch (~655) uses `listing.retry_count`
read BEFORE the publish attempt even started.

**Problem:** two overlapping runs (dashboard "Publish now" + CLI run, or rapid re-runs) can
both compute the same `retry_count`, giving a row extra lives beyond `MAX_RETRIES = 3` and
delaying the terminal-error Slack alert.

**Fix:** make the increment atomic — an RPC doing
`UPDATE listings SET retry_count = retry_count + 1, ... WHERE id = $1 RETURNING retry_count`,
then branch pending/error on the returned value. Low urgency while operation is
single-human; cheap to fold into the H4 work.

---

## LOW / code smells

### [ ] L1 — Tight retry loop without backoff in `run()`
`packages/listing/src/index.ts:70-89`: a failing `pending_publish` row is retried up to 3×
back-to-back within seconds (each attempt costs real Etsy calls). Add a small delay or skip
the same id within one run after a failure.

### [ ] L2 — Image-upload resume skip is positional
`packages/listing/src/publisher.ts:467-496`: resume skips the first `alreadyUploaded`
entries of `uploadUrls` by index. If the operator changes the image *selection* (or its
order) between attempts, ranks no longer correspond — duplicated or misordered carousel.
Consider comparing against the actual uploaded images (`getListingImages`) instead of count.

### [ ] L3 — `loadListingState` swallows its DB error
`packages/listing/src/publisher.ts:361-371`: drops `error` and returns null → a transient
DB failure reports as "Listing not found". Distinguish the two.

### [ ] L4 — `deleteListing` throws after succeeding to surface a warning
`packages/dashboard/lib/actions/listings.ts:947-949`: "Listing deleted, but…" thrown as an
Error — the UI shows failure for an operation that worked. Return a structured result.

### [ ] L5 — Files exceed the repo's own 800-line budget
`packages/dashboard/lib/actions/listings.ts` (1011), `packages/dashboard/lib/actions/design.ts`
(863), `packages/design/prompt_builder.py` (852). `listings.ts` splits naturally into
copy-editing / lifecycle / mockup-generation modules.

### [ ] L6 — `computeEtsyFees` charges the $0.20 listing fee on every order
`packages/ledger/src/economics.ts:25-32`: listing fees are per listing creation/renewal,
not per sale, so per-order margin is slightly understated (conservative direction, but the
digest presents it as exact). Either drop it from per-order fees or rename/document.

### [ ] L7 — Watchdog uses module-level mutable `_now`
`packages/ledger/src/watchdog.ts:109-111`: works single-threaded but it's hidden state;
thread `now` through as a parameter.

### [ ] L8 — RPC EXECUTE hygiene
`claim_pending_design_package` (migration 048) and other RPCs are executable by
`anon`/`authenticated` by default; RLS makes the inner writes fail, but add an explicit
`REVOKE EXECUTE ... FROM anon, authenticated` in a follow-up migration so the deny is
intentional rather than incidental.

---

## Notably good (no action; context for future reviewers)

- Compliance layer (`packages/shared/src/etsy-compliance.ts`) is true defense-in-depth:
  sanitize at write/save/publish with `validateNoEmDash` as the final hard assertion, and
  the disclosure-substring-before-forbidden-term-scan subtlety handled.
- RLS story is complete: deny-all baseline (031), the policy-subquery-under-RLS realtime
  fix (044, with an empirical repro in the migration comment), security-definer view closed
  (057).
- `packages/design/main.py`'s error handler is the model for H4's catch-path fix: every
  secondary DB write individually guarded so the Slack alert always fires.
- No cron/timer/self-loop anywhere — all four `while` loops are drain-and-exit; the
  manual-only contract holds.
- Printify client: unified retry budget, rate-class chaining, response bodies kept out of
  `error_message` to avoid PII leaking to Slack.
- Dashboard auth is fail-closed (empty allowlist denies); every action file except
  triggers.ts (M5) checks auth in every export. No `any` in app code; no hardcoded secrets
  found.
