# AUDIT_4 — Presswork Codebase Audit

Date: 2026-05-13
Scope: full monorepo — Scout, Design, Listing, Ledger, shared libs, dashboard, Supabase migrations, tests.
Findings ordered by descending severity. Each entry: location, problem, why it matters, fix sketch.

---

## CRITICAL

### C1. RLS disabled on all agent and credential tables
`infra/supabase/migrations/` — `trend_briefs`, `design_packages`, `listings`, `orders`, `agent_runs`, `llm_usage`, `config`, plus anything else outside `runtime_flags` (only 024 enables RLS).

The architecture relies on "service-role only on the server" as the access-control story. There is no DB-level deny: anyone holding the publishable `NEXT_PUBLIC_SUPABASE_ANON_KEY` (which is by design public) plus the project URL can read/write these tables if a single dashboard code path ever uses the browser client against them. `config` holds Etsy OAuth tokens, so the blast radius includes credential theft.

Fix: enable RLS on every non-`runtime_flags` table and add an explicit owner-only policy (email ∈ `DASHBOARD_ALLOWED_EMAILS` via a claims check) plus a service-role bypass. Treat RLS as a safety net under the service-role architecture, not as a separate access model.

### C2. Realtime publication broadcasts unprotected tables via the anon key
`infra/supabase/migrations/027_realtime_publication.sql:11-13`

`trend_briefs`, `design_packages`, and `agent_runs` are added to the `supabase_realtime` publication. Realtime WebSocket auth uses the anon key. Because none of these tables have RLS, any client with the public anon key + project URL can subscribe to row-change events and receive prompts, image URLs, owner email in `agent_runs.triggered_by`, and full agent stdout/stderr tails as they stream. The migration comment ("anon key can already SELECT") is incorrect for the realtime path under the current RLS posture.

Fix: enable RLS first (C1), then keep these tables in the publication. Or remove them from the publication and switch the dashboard to authenticated server-sent polling.

### C3. Scout poller has no row locking and dedupe is non-atomic
`packages/scout/main.py`, `packages/scout/dedup.py:16-42`

Design uses a Postgres RPC `claim_pending_trend_brief` with `FOR UPDATE SKIP LOCKED` — correct. Scout has no equivalent: it iterates `NICHE_SEEDS` and inserts directly. `is_recent_duplicate` and `is_semantic_duplicate` run as two separate non-transactional reads, with the insert as a third call. If two Scout processes overlap (Railway redeploy mid-cron, manual trigger + cron, or operator double-click) both pass dedupe and both insert. CLAUDE.md explicitly requires `FOR UPDATE SKIP LOCKED` on all polling queries; Scout violates that contract.

Fix: wrap dedupe + insert in a Postgres function with an advisory lock, or add a unique constraint such as `(niche, date_trunc('day', created_at))` so a duplicate insert fails fast.

### C4. `get_db()` caches a Supabase client for the process lifetime with no health check
`packages/shared_py/db.py:26`

`@lru_cache` returns a single `Client` forever. The underlying `httpx` session can die from a transient network partition; the cached client will not reconnect. Long-running Design runs perform many sequential DB writes — a dead session mid-pipeline surfaces as unexpected transport errors that leave a brief in `processing` with no completion path.

Fix: drop `lru_cache`; use a module-level `_client: Client | None = None` with lazy init, or construct a short-lived client per task.

---

## HIGH

### H1. Zod status schemas miss live statuses → runtime parse failures
`packages/shared/src/types.ts:6, 28`

`TrendBriefStatusSchema` is `z.enum(["pending", "processing", "done", "error"])`. Migration 021 introduced `"needs_review"`, `"needs_description"`, `"approved"` as live values. `DesignPackageStatusSchema` is missing `"needs_review"` and `"approved"` — both states the Design poller actively claims. Anything that calls `TrendBriefSchema.parse(row)` or `DesignPackageSchema.parse(row)` on a real DB row will throw. Risk: silent test-only success, prod parse explosions.

Fix: align both schemas with current migration state, add a schema/migration parity test.

### H2. Listing terminal-error alert never fires
`packages/listing/src/publisher.ts:203-206, 406+`

CLAUDE.md: "If ≥ 3 → stay in error, **alert**." `publishOne` and `resumePublish` write the error row but never call `notifySlack` / `notifyEmail` on reaching the retry cap. Combined with the cross-function retry count (`publishOne` failure + `resumePublish` failures share the budget), a listing can exhaust retries entirely silently.

Fix: emit a terminal-failure alert in both `publishOne` and `resumePublish` when `retry_count >= MAX_RETRIES`. Add a unit test asserting the call.

### H3. `rejectListing` has no current-status guard
`packages/dashboard/lib/actions/listings.ts:55-72`

`approveListing` correctly checks `row.status !== "needs_review"` and uses `.eq("status", "needs_review")` as an optimistic-concurrency guard. `rejectListing` does neither — it can overwrite `publishing` or `active` rows with `error`. A stale tab can corrupt a live listing.

Fix: mirror the `approveListing` guard pattern; reject only when current status is `needs_review`.

### H4. Status CHECK constraints absent on three core tables
`infra/supabase/migrations/` — `trend_briefs`, `design_packages`, `listings`

Only `orders` has a real CHECK on `status` (migration 016). The other three tables accept any text. Migration 021's comment acknowledges this. The state machine is enforced only in app code and RPCs; a bad write or a manual Supabase Studio edit silently corrupts state.

Fix: add CHECK constraints on all three tables enumerating the legal values from CLAUDE.md.

### H5. Migration 011's `NOT VALID` CHECK never validated before 016 replaced it
`infra/supabase/migrations/011_orders_status_check.sql`, `016_orders_ledger_only.sql`

011 added a CHECK as `NOT VALID` with no follow-up `VALIDATE CONSTRAINT`. Any rows written between 011 and 016 with non-matching status escaped the constraint. 016 replaces it cleanly, so no ongoing risk, but it's a procedural gap worth recording.

Fix: as a policy, always pair `NOT VALID` with a later `VALIDATE CONSTRAINT` in the same migration after backfill.

### H6. Unauthenticated `/api/healthz` leaks per-table error counts
`packages/dashboard/app/api/healthz/route.ts:14`, `middleware.ts` (PUBLIC_PATHS)

Endpoint is public by design but returns per-agent error volumes — useful for an attacker to time exploitation against a stalled pipeline. Single-operator deployment makes this lower risk but still leaks operational signal.

Fix: gate with a bearer token, or return only `{ ok: boolean }` to unauthenticated callers.

### H7. Design's outer `except Exception` is not failure-safe
`packages/design/main.py:294-363`

The error handler calls `_select_retry_count` and `upsert` on `design_packages` without nested try/except. If either secondary write fails, the exception escapes the handler, the `trend_briefs` status update and Slack alert never fire, and the brief is stuck in `processing` permanently — the exact orphan state the handler exists to prevent.

Fix: wrap secondary writes in nested try/except, mirroring `packages/scout/main.py:111-122`.

### H8. Sync/async Anthropic client split is invisible to callers
`packages/design/prompt_builder.py:375, 647`

`build_flux_prompt` / `build_gpt_image_prompt` use sync `Anthropic` and are only safe because `main.py` wraps them in `asyncio.to_thread`. Scout uses `AsyncAnthropic` directly. Any future async caller of these functions without `to_thread` blocks the event loop.

Fix: migrate to `AsyncAnthropic`, or add a module-level docstring + a `# DO NOT call from async without to_thread` marker.

### H9. `is_semantic_duplicate` does an unbounded Claude call per candidate
`packages/scout/dedup.py:42`

Every candidate that passes the fast dedupe still calls Claude with 50 recent briefs in context. No textual short-circuit when candidates are obviously different. Cost amplifies with niche-seed count and is not bounded per run.

Fix: cheap text-similarity (token overlap or embedding) gate first; only fall through to Claude when above a threshold. At minimum, log per-run Claude spend so the surface is visible.

### H10. Scout test coverage is essentially absent
`packages/scout/test_main.py` — one test (`test_scout_failure_sends_slack_alert`)

No tests for: insert writing `status='needs_review'`, `_MAX_INSERTS` cap, both dedupe paths, retry budget, error-row insert. CLAUDE.md mandates status-transition coverage for Scout. Currently unenforced.

Fix: add the four missing tests above. Pattern off Design's test suite.

### H11. Concurrent poller tests missing for Listing and Scout
`packages/listing/tests/integration/`, `packages/scout/tests/`

Design has `test_concurrent_claims_no_duplicates`. Listing claims via `claim_pending_design_package` (`FOR UPDATE SKIP LOCKED` in migration 021) but has no concurrent-poller test. Scout has no concurrency test at all (compounds C3). CLAUDE.md lists row locking under concurrent pollers as required coverage.

Fix: replicate the Design pattern for Listing; add one for Scout once C3 is in place.

### H12. E2E pipeline test asserts behavior that no longer exists
`tests/e2e/full-pipeline.test.ts:58, 196-219`

Sets `HUMAN_REVIEW_ENABLED: "false"` and expects `publishOne` to land at `status === "active"`. Migration 030 dropped that flag; CLAUDE.md says "no auto-approve runtime flags … those were removed." The test either fails or silently passes because the env var is ignored — either way it asserts the wrong contract, masking whether the gate is real.

Fix: rewrite the E2E to expect `needs_review` after `publishOne`, then drive a dashboard-style approval to `pending_publish`, then assert `executeEtsyPublish` lands at `active`.

### H13. Design retry budget never tested at the terminal boundary
`packages/design/test_main.py`

Tests assert error-status writing + alert, but `design_retry_count=2` (the failing-third-attempt case) is never exercised. CLAUDE.md mandates this test.

Fix: add a test that seeds `design_retry_count=2`, forces failure, and asserts `status='error'`, no retry, alert sent.

---

## MEDIUM

### M1. `generatePalette` skips auth on the server action
`packages/dashboard/lib/actions/palette.ts:21`

Every other server action checks `if (!email) throw`. This one calls `await requireOwnerEmail()` and discards the return. Middleware is documented as not sufficient — direct POST can bypass it.

Fix: pattern-match other actions; throw on null email.

### M2. Colormind upstream is plain HTTP
`packages/dashboard/lib/actions/palette.ts:15`

`http://colormind.io/api/` — server-side fetch over plaintext, response parsed and returned to the browser. No user data sent, but mixed-protocol nonetheless.

Fix: switch to HTTPS or document.

### M3. `runtime_flags` key is length-validated only
`packages/dashboard/lib/actions/flags.ts:8`

`z.string().min(1).max(120)` permits any key. Operator typo can plant an orphan key that a future flag reader treats as a bypass signal.

Fix: `z.enum([...known_flags...])` allowlist.

### M4. `image_url` passed to Printify without domain validation (SSRF surface)
`packages/listing/src/publisher.ts:140`

`design.image_url` originates from Supabase Storage normally, but the Builder flow + direct DB edits can plant arbitrary URLs. Printify then fetches them server-side. Blast radius is Printify's infra, not ours, but the URL should be host-allowlisted.

Fix: assert hostname matches Supabase Storage or a known CDN before the upload call.

### M5. Supabase `.update` error returns discarded
`packages/listing/src/publisher.ts:155-163, 166`

`.update({ mockup_urls, mockups_from_actual_design: true, … })` on `design_packages` and the follow-up `listings` update discard their `error` returns. A silent write failure leaves `mockups_from_actual_design=false` and `validateMockupProvenance` stalls the resume path with no actionable log.

Fix: destructure `{ error }` and throw a `PublisherError` on truthy.

### M6. Ledger `sale_price_usd` omitted as `undefined` rather than explicit `null`
`packages/ledger/src/receipt-poller.ts:88-93`

Works only because supabase-js drops `undefined` keys. Interface still types `sale_price_usd?: number`, which permits accidentally passing `0` and treating it as a valid price.

Fix: explicit `sale_price_usd: number | null` in the type; pass `null` explicitly when unknown.

### M7. `resumePublish` race on `retry_count`
`packages/listing/src/publisher.ts:406`

`retry_count` is read once from the initial SELECT and incremented locally. Two concurrent invocations (double-clicked Approve + cron overlap) read the same value, both write the same incremented value, last write wins — one failure escapes the budget.

Fix: increment via `.update({ retry_count: existing + 1 })` with an `.eq("retry_count", existing)` optimistic guard, or move to a stored procedure with `FOR UPDATE`.

### M8. `printifyFetch` mislabels network failures as 4xx
`packages/shared/src/printify-http.ts:145-149`

Non-`PrintifyError` exceptions (DNS, connect timeouts) get bucketed into `"4xx"`. Inflates the 4xx counter and can prematurely flip the error-rate guard to `ok=false`.

Fix: separate `"network"` outcome category; don't count network errors against the 4xx Printify rate.

### M9. `runtime_flags._cache` is module-level mutable
`packages/shared_py/runtime_flags.py:16`

Persists for the process lifetime. Tests that don't patch `get_db` poison subsequent tests with stale values. If agents ever become long-running daemons, flag changes won't take effect until restart.

Fix: autouse fixture calling `_reset_runtime_flag_cache` in `conftest.py`. Document per-process caching explicitly.

### M10. Scout analyzer logs `str(exc)` on vision fallback
`packages/scout/analyzer.py:137`

`str(exc)` on `BadRequestError` ships the full Anthropic response body — including the user content block — into structured logs. Listing titles aren't sensitive but the pattern sets a precedent that may capture prompt content or other API responses elsewhere.

Fix: log `exc.status_code` / `type(exc).__name__` for known exception types; reserve full stringification for unexpected ones.

### M11. Pillow decompression-bomb exposure
`packages/design/image_processor.py:29`

`Image.open` on fal output with no explicit `MAX_IMAGE_PIXELS` policy and no `DecompressionBombError` handling. A malformed/oversized fal response triggers an uncaught error after the expensive fal stages were paid for.

Fix: set `Image.MAX_IMAGE_PIXELS` explicitly and catch `DecompressionBombError` with a Slack alert.

### M12. Migration 028 runs two statements without a transaction
`infra/supabase/migrations/028_drop_print_style.sql:15-16`

Bare `UPDATE` then `DROP COLUMN`. A failure between them leaves the column in place with all values set to `full_color` plus the 014 CHECK still applied. Low practical risk, inconsistent with 016's pattern.

Fix: wrap in `BEGIN/COMMIT`.

### M13. Currency normalization test hardcodes the FX rate
`packages/ledger/src/economics.test.ts:47`

`normalizeToUsd(24.99, 'EUR') ≈ 24.99 * 1.08` — magic constant baked into both impl and test. Rate changes pass the test while silently breaking the contract.

Fix: assert directional relationship or import the same constant the implementation uses.

---

## LOW

### L1. `loadExistingListing` will resume from an `error` row
`packages/listing/src/publisher.ts:240-252`

Docstring says error rows abort; the guard at line 64 only checks `is_active`. A row with `status='error'` and `is_active=false` passes through and `canResumeCopy` may be true. Operator intent post-terminal-error is dashboard retry, not auto-resume.

Fix: add `existing.status !== "error"` to the guard.

### L2. `retryBrief` resets to dead status
`packages/dashboard/lib/actions/scout.ts:75`

Sets `trend_briefs.status='pending'`. Comment elsewhere in the file states `"'pending' is a dead state post-migration-021 — Design only claims 'approved'"`. The brief will appear stuck.

Fix: route to `needs_review` (re-trigger human review) or `approved` (re-trigger Design).

### L3. `referenceUrlsSchema` allows arbitrary hosts
`packages/dashboard/lib/actions/builder.ts:75`

`^https?:\/\//i` permits `https://169.254.169.254/...`. URLs are passed to Claude as vision inputs; if Anthropic fetches them, the dashboard becomes an SSRF probe relay. Allowlist auth surface limits exploitability, but a compromised allowlisted email could use it.

Fix: restrict to `https://`, block private/link-local ranges via DNS resolution, or maintain a hostname allowlist.

### L4. `design_packages.trend_brief_id` is nullable
`infra/supabase/migrations/002_design_packages.sql:5`

Combined with the partial UNIQUE excluding NULLs (013), this permits multiple orphan design packages. Likely intentional for manual injection but worth confirming.

Fix: confirm intent; if intentional, document. If not, `NOT NULL` plus FK.

### L5. `config` table credential exposure under C1/C2
`infra/supabase/migrations/003_listings.sql` (creates `config`)

Etsy OAuth tokens live here. Service-role only by convention but with no RLS guard. Flagged separately because of credential sensitivity — fix as part of C1.

### L6. `llm_usage` index leading-column mismatch
`infra/supabase/migrations/018_llm_usage.sql`

Composite index `(agent, provider, created_at DESC)` does not serve dashboard queries that filter by `provider` alone.

Fix: add `CREATE INDEX ON llm_usage (provider, created_at DESC)`.

### L7. No XSS, secret leakage, or token logging detected
Across all packages, no `dangerouslySetInnerHTML`, no hardcoded keys, no Bearer-header or raw-token logging. Service-role key correctly isolated to `lib/supabase/server.ts` with `import "server-only"` guard.

### L8. Triggers action is injection-safe
`packages/dashboard/lib/actions/triggers.ts:101` — agent parsed through `z.enum`, command map is a hardcoded `{ bin, args }` table. No injection surface.

---

## Headline remediation order

1. ✅ C1 + C2 — RLS baseline and realtime publication trim (cloud applied).
2. ✅ C3 + C4 — Scout atomic dedupe RPC and lazy `get_db()` singleton.
3. ✅ H1 + H4 — zod schemas aligned and CHECK constraints applied in cloud (migration 034). H5 procedural lesson now codified by the H4 pattern (no `NOT VALID`).
4. ✅ H2 + H3 + H6 — Listing terminal Slack alert, `rejectListing` guarded, `/api/healthz` payload trimmed with optional bearer.
5. ✅ H7 + H8 — Design error handler hardened; `prompt_builder.py` refactored to native async with shared helpers, eliminating the sync/async fragility.
6. ⏳ H9 — cost short-circuit on `is_semantic_duplicate`. Needs separate cost analysis.
7. ⏳ H10 + H11 + H12 + H13 — Scout/Design test gaps, concurrent poller tests, broken E2E. Best done as one focused test-only pass.
8. ⏳ Medium and low items as time permits.

---

## Completion Tracker

CRITICAL items addressed in the current pass. HIGH/MEDIUM/LOW remain open and will be picked up in a follow-up pass.

Legend: `[x]` = applied in cloud and verified; `[~]` = code/migration in repo, awaiting cloud apply.

- [x] C1 — RLS baseline applied in cloud: `trend_briefs`, `design_packages`, `listings`, `orders`, `agent_runs`, `llm_usage`, `config`, `runtime_flags`, `dashboard_allowed_emails` all have `relrowsecurity=true`. Operator email `ben.bracamonte@gmail.com` seeded into `dashboard_allowed_emails` (migration `031_rls_baseline.sql`).
- [x] C2 — Realtime publication trimmed in cloud: `pg_publication_tables` for `supabase_realtime` returns only `agent_runs`. Policy `agent_runs_read_allowlist` (SELECT, `authenticated` role) is present and gated on `dashboard_allowed_emails` (migration `032_realtime_publication_trim.sql`).
- [x] C3 — Atomic Scout dedupe applied in cloud: `pg_proc` shows `insert_trend_brief_if_no_recent`, `pg_indexes` shows `uniq_trend_briefs_niche_day`. `packages/scout/main.py:69+` routes through the RPC with NULL-return and 23505 handling. Unit tests in `packages/scout/test_main.py` cover insert, RPC-null-skip, and belt-violation-skip branches (migration `033_scout_dedupe_atomic.sql`).
- [x] C4 — `get_db()` is a lazy module-level singleton with `_reset_db_client()` test helper (`packages/shared_py/db.py`). Autouse fixture in `conftest.py` resets the cache before and after every test. `packages/shared_py/test_db.py` covers singleton identity, reset semantics, and anon-key rejection. Integration tests in scout/design updated from `get_db.cache_clear()` to `_reset_db_client()`.

### Verification done in this pass
- `pytest packages/scout packages/shared_py packages/design` (non-integration): 135 passed.
- `npm test --workspaces`: shared 66/66, listing 118/121 (3 pre-existing skips), ledger 14/14.
- `npx supabase db push --include-all`: applied 024, 030, 031, 032, 033 to cloud (`mtugxwcpuytokdtupuve`). Idempotent re-push: "Remote database is up to date."
- RLS, publication, policy, RPC, and belt-index existence confirmed via `npx supabase db query --linked` against the cloud DB.

### Smoke tests to run when convenient (not blocking the CRITICAL fix)
1. Sign in to the dashboard with the allowlisted email and confirm `AgentRunStatus` realtime still updates after triggering an agent run.
2. From a Node REPL using only `NEXT_PUBLIC_SUPABASE_ANON_KEY`, verify `.from('config').select('*')` returns zero rows / permission error.
3. `INTEGRATION=1 pytest packages/scout/tests/integration` against the upgraded cloud schema; both integration tests should pass.

---

## HIGH Pass — Completion Tracker

Second pass against AUDIT_4 (HIGH severity + prompt_builder refactor). Same legend as the CRITICAL tracker.

- [x] H1 — `TrendBriefStatusSchema` / `DesignPackageStatusSchema` aligned with migration-021+ state machine; new parity test `packages/shared/tests/types-status.test.ts` codifies the full live enum so a future regression fails fast.
- [x] H2 — `publishOne` and `resumePublish` now call `notifySlack` with `severity='error'` on terminal retry-cap failure. Three new tests in `packages/listing/src/publisher.test.ts` cover both paths and the negative-case (no alert below the cap).
- [x] H3 — `rejectListing` re-fetches and re-checks `status='needs_review'` (mirrors `approveListing`), with `.eq('status','needs_review')` optimistic concurrency guard. Test infra absent in the dashboard package; relying on manual smoke.
- [x] H4 — Migration `034_status_check_constraints.sql` applied in cloud. `trend_briefs`, `design_packages`, `listings` each have a CHECK constraint enumerating the legal status set. Audit-then-backfill phase reported zero non-conforming rows. Idempotent re-push: "Remote database is up to date."
- [x] H5 — Procedural lesson resolved as part of H4's pattern: H4 uses a normal CHECK (not `NOT VALID`), so the constraint is validated immediately. Going forward, all status constraints follow this pattern.
- [x] H6 — `/api/healthz` default payload trimmed to `{ ok, db, now }`. Detailed `error_counts` only returned when `Authorization: Bearer ${HEALTHZ_BEARER}` matches. Wrong/missing bearer silently downgrades — no timing oracle. `.env.example` documents the optional secret.
- [x] H7 — Design's outer `except` now wraps `_select_retry_count` / `design_packages.upsert` / `trend_briefs.update` in nested try/except blocks. Slack alert always fires regardless of secondary DB outcomes. Two new tests in `packages/design/test_main.py` cover both inner-exception branches.
- [x] H8 — `packages/design/prompt_builder.py` refactored to native async (`AsyncAnthropic`), with shared helpers `_preprocess_custom_prompt`, `_build_user_content`, `_parse_json_response`, `_call_claude`. ~80 lines of duplication removed. `packages/design/main.py:88` no longer needs `asyncio.to_thread`. All 51 prompt_builder tests pass.

### Verification done in this pass
- `pytest packages/scout packages/shared_py packages/design --ignore=*/integration`: 137 passed.
- `npm test --workspaces`: shared 70/70, listing 121/124 (3 pre-existing skips), ledger 14/14.
- `tsc -p packages/dashboard --noEmit`: clean.
- `npx supabase db push`: applied 034; re-push reported "Remote database is up to date."
- Live constraint check: `INSERT INTO trend_briefs (niche, status) VALUES (..., 'bogus_status')` rejected with `23514: violates check constraint "trend_briefs_status_check"`.

### Smoke tests for the next dashboard sign-in
1. Open two browser tabs on the same listing in `needs_review`. Approve in tab A. Try Reject in tab B → expect error toast, listing unchanged (H3 guard).
2. `curl https://<dashboard>/api/healthz` returns `{ ok, db, now }` (no `error_counts`). Set `HEALTHZ_BEARER` in Railway env and `curl -H "Authorization: Bearer <value>"` returns the detail block (H6).
3. (Hard to force) Next time a listing burns through 3 retries, confirm a single Slack alert with `LISTING_ID` and "terminal" in the body fires (H2).

### Next pass — pick up from here
H9 (cost short-circuit on `is_semantic_duplicate`) and H10–H13 (test gaps: Scout retry budget, concurrent pollers, broken E2E, Design terminal-boundary test) remain. Recommended: bundle H10–H13 as a single test-focused pass; H9 separately after a cost-impact read.

### Next pass — pick up from here
The HIGH/MEDIUM/LOW findings above remain untouched. Suggested next batch per the headline remediation order: H1 (zod status schemas), H2 (listing terminal-error alert), H3 (`rejectListing` guard).

Last touched: 2026-05-13
