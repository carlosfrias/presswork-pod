# CLAUDE.md — Etsy AI Agent Pipeline

Source of truth for Claude Code on this project. Read fully before changing anything.

---

## Project Overview

Autonomous 4-agent print-on-demand pipeline on Etsy + Printify:

1. **Scout** (Python) — scans Etsy for trends → `trend_briefs`
2. **Design** (Python) — generates art via fal.ai / OpenAI image models → `design_packages`
3. **Listing** (TS) — publishes SEO listings via Etsy API v3 → `listings`
4. **Ledger** (TS) — polls Etsy receipts, logs economics, emits margin/revenue alerts → `orders`

Order fulfillment itself is handled by **Etsy's native Printify integration**, not by this codebase. The Ledger Agent is metrics-only; it never calls the Printify API.

Agents are **loosely coupled via Supabase**. No direct agent-to-agent calls — each reads inputs and writes outputs through DB tables.

> **"Autonomous" describes the design goal, not the current runtime.**

---

## Automation Status — MANUAL ONLY (no auto-firing)

**Nothing in this system runs on a schedule. No cron jobs are deployed or active. No agent action fires on its own — ever — under the current configuration.**

We are *building toward* an automated pipeline, but every agent runs only when the operator invokes it:

- **Every agent is a one-shot, drain-and-exit process.** Scout, Design, Listing, and Ledger each claim queued work, process it, and **exit**. None of them self-loop or self-schedule. (The `while` loops in `packages/listing/src/index.ts` and `packages/design/main.py` break the moment the queue is empty — they drain, they don't poll forever.) Any "polls every 15 min" / "nightly cron" language elsewhere in this doc describes the *intended* deployed cadence, i.e. how often an external scheduler *would* re-invoke the one-shot process — **not** behavior that is currently live.
- **No external scheduler is connected.** `infra/railway.toml` is the only place cron schedules exist, and its service blocks are **commented out**. Railway is not deployed. Re-enabling automation is a single, deliberate edit to that file — do not make it without explicit instruction.
- **No GitHub Actions schedule fires agents.** The only workflows are `ci.yml` and `integration.yml`, triggered by PR/push for quality gates — never on a timer, never running agent business logic.
- **Dashboard "Run agent" buttons are manual and gated.** They spawn a local subprocess only when `DASHBOARD_LOCAL_TRIGGERS_ENABLED=true` (default `false`), and only on an explicit operator click. That is a manual trigger, not automation.
- **Human gates remain mandatory regardless.** Every agent's output is human-reviewed before the next stage; see the status-flow rules below.

**When changing anything in this repo, do not introduce a cron, timer, `setInterval`, scheduled GitHub Action, process manager (pm2/systemd), or self-looping agent that would cause an agent action to fire without a manual operator trigger. If a task seems to require unattended scheduling, stop and confirm first.**

---

## Monorepo Structure

npm workspaces; Python packages own their `requirements.txt`.

- `packages/shared/` — TS lib (Supabase client, types, logger, zod config, HTTP clients)
- `packages/shared-py/` — Python lib (pydantic, supabase-py, config, structlog)
- `packages/scout/` — Agent 1 (Python)
- `packages/design/` — Agent 2 (Python)
- `packages/listing/` — Agent 3 (TS) — `compliance.ts` is the policy gate
- `packages/ledger/` — Agent 4 (TS) — Etsy receipt polling, economics logging, margin/revenue digests
- `infra/supabase/migrations/` — SQL migrations (`001_*.sql` …) — **schema lives here, not in this file**
- `infra/railway.toml` — Railway service definitions
- `scripts/` — one-off ops scripts

---

## Tech Stack

| Layer | Tool |
|---|---|
| Scout + Design | Python 3.12 (`httpx`, `pydantic`, `structlog`) |
| Listing + Ledger | TypeScript / Node 20 (strict mode, `zod`, `bottleneck`) |
| AI reasoning | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| Image gen | fal.ai / OpenAI via fal.ai (`fal_gpt_image_2` default; `fal_flux_pro`, `fal_nano_banana_2` also supported — per-brief `image_model` field) |
| Database | Supabase (Postgres) — agent handoff state |
| Storage | Supabase Storage — design PNGs, mockups |
| Hosting / cron | **Manual local CLI only — no cron deployed or active** (see "Automation Status" above). Railway TBD; its `railway.toml` crons are commented out. Dashboard can spawn agents locally only via `DASHBOARD_LOCAL_TRIGGERS_ENABLED=true` on an explicit click |
| Print fulfillment | Etsy's native Printify integration (out of band) |
| Alerts | Resend (email) + Slack webhooks |
| Secrets | Railway env vars only — never in code |

---

## Environment Variables

Template in `.env.example`. Never commit values.

```bash
ANTHROPIC_API_KEY=
ETSY_API_KEY= ETSY_API_SECRET= ETSY_SHOP_ID=
ETSY_ACCESS_TOKEN= ETSY_REFRESH_TOKEN=
ETSY_PRODUCTION_PARTNER_ID=   # numeric, from Shop Manager → Production Partners. Required.
FAL_KEY=
PRINTIFY_API_TOKEN= PRINTIFY_SHOP_ID=        # used by Listing only (product create); Ledger never calls Printify
SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY=    # service role only, never anon in backend
RESEND_API_KEY= ALERT_EMAIL= SLACK_WEBHOOK_URL=
NODE_ENV=development LOG_LEVEL=info
SCOUT_VISION_ENABLED=false    # true → Scout sends Etsy thumbnails to Claude (+~3-5× tokens)
DASHBOARD_ALLOWED_EMAILS=     # comma-separated owner-email allowlist for the dashboard
NEXT_PUBLIC_SUPABASE_URL=     # same as SUPABASE_URL — read by browser-side dashboard auth
NEXT_PUBLIC_SUPABASE_ANON_KEY= # publishable key (sb_publishable_...), NOT service role
DASHBOARD_LOCAL_TRIGGERS_ENABLED=false  # true → dashboard "Run agent" buttons spawn local subprocess
```

---

## Database Schema

Full DDL lives in `infra/supabase/migrations/`. Four core tables drive agent handoffs:

| Table | Owner | Status flow |
|---|---|---|
| `trend_briefs` | Scout writes, Builder/Design read | `needs_review` → `needs_description` → `approved` → `processing` → `done` \| `error` |
| `design_packages` | Design writes, Listing reads | `needs_review` → `touch_up` → `needs_review` → `approved` → `processing` → `done` \| `error` |
| `listings` | Listing | `pending` → `needs_review` → `pending_publish` → `publishing` → `active` \| `error` |
| `orders` | Ledger | `logged` \| `error` (terminal — fulfillment lives outside this codebase) |

Rules:
- **Never skip a status step.** Enforce transitions in code.
- **Every agent's output is human-gated. No bypass.** Scout writes `needs_review`; Scout-approve transitions to `needs_description`; Builder writes the image description and transitions to `approved`; Design claims `approved` and writes `needs_review` on completion; Listing claims `approved` design packages, builds the Printify product, then pauses at listings `needs_review` until the dashboard's Approve flips the row to `pending_publish`. No auto-approve runtime flags, no `HUMAN_REVIEW_ENABLED` env override — those were removed in migration 030.
- `orders.margin_usd` is a generated column: `sale_price_usd − print_cost_usd − shipping_cost_usd − etsy_fees_usd` (migration 052 added `shipping_cost_usd` — the Printify fulfillment shipping the shop absorbs on every order, since listings ship free to the buyer; `BLUEPRINT_SHIPPING_COST_USD` in the Ledger).
- `orders` has no Printify/tracking columns — those were dropped in migration 016 when fulfillment moved to Etsy's native Printify integration.
- `trend_briefs.image_description` — Builder-authored prompt text (renamed from `custom_flux_prompt` in migration 045). When non-null, Design uses it verbatim instead of calling Claude.
- `design_packages.mockups_from_actual_design BOOLEAN NOT NULL` — provenance flag (compliance rule 4).
- Every table has `created_at`, `updated_at` (auto via trigger), `error_message`, `retry_count`.

---

## Agent Specifications

### Agent 1 — Scout (`packages/scout/`)
Nightly cron (`0 2 * * *`). Produces 3–5 `trend_briefs/run`.

1. Load niche seeds from Supabase `config` table.
2. `GET /listings/active` from Etsy, `sort_on=score`. Max 5 req/sec (asyncio semaphore).
3. Extract titles, tags, prices, review counts.
4. Claude Sonnet → structured `TrendBrief` JSON (`niche`, `style_keywords`, `top_tags`, `price_target_usd`, `color_palette`). System prompt forbids shop/artist/IP names.
5. Dedupe vs last 7 days. Insert with `status='needs_review'`.

Set `SCOUT_VISION_ENABLED=true` to also send Etsy listing thumbnails to Claude (vision-aware analyzer). Off by default — adds ~3-5× per-run token cost.

### Agent 2 — Design (`packages/design/`)
Polls every 15 min for `trend_briefs.status='approved'` (via `claim_pending_trend_brief` RPC).

1. Claim row → `processing`.
2. Claude Sonnet crafts image prompt (never artist/brand/IP names). If the Builder has written an `image_description` on the brief, that text is used verbatim (skipping Claude). The historical FLUX_REQUIRED_TERMS suffix was removed — no hardcoded phrase appending.
3. Generate image via the per-brief `image_model` field: `fal_gpt_image_2` (default, OpenAI gpt-image-2 on fal.ai), `fal_flux_pro` (FLUX Pro 1.1), or `fal_nano_banana_2` (Gemini-3 on fal.ai). Each backend uses its own client with model-appropriate sizing.
4. Pillow → 300dpi transparent-bg PNG → Supabase Storage (`designs/` bucket).
5. Write `design_packages` row including `printify_blueprint_id` + `printify_variant_ids`. Mark `trend_briefs.status='done'`.

**Mockups are NOT Design's job** — Printify has no standalone mockup endpoint. Listing populates `mockup_urls` + `mockups_from_actual_design=true` as a side effect of creating the Printify product.

### Agent 3 — Listing (`packages/listing/`)
Polls every 15 min for `design_packages.status='done'`.

1. Fetch row + joined `trend_briefs`.
2. `validatePricingFloor`: reject if `price_usd < print_cost × 2.5`.
3. `validateProductionPartnerId`: fail fast if `ETSY_PRODUCTION_PARTNER_ID` missing.
4. Claude Sonnet → `{title, description, tags}` JSON. System prompt in `copywriter.ts` enforces the 4 seller-policy rules — keep prompt and validators in sync.
5. `validateCopyCompliance`: AI disclosure verbatim, no forbidden terms, no external URLs/handles/off-platform phrasing.
6. Create Printify product (`is_visible=false`) using `image_url` + blueprint/variant IDs. Read returned mockup URLs → write to `design_packages.mockup_urls` AND set `mockups_from_actual_design=true` in the same write.
7. Always pause at `needs_review`. Owner approves on the dashboard → status flips to `pending_publish`; the next listing run picks the row up and drives the Etsy publish via `resumePublish` / `executeEtsyPublish`. No auto-publish path.
8. On publish (`executeEtsyPublish`): re-run full compliance gate (defense-in-depth). Create Etsy draft with `production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID]`, `who_made:"i_did"`, `when_made:"made_to_order"`, `is_supply:false`, plus blueprint-keyed `materials` and `processing_min/max`.
9. PUT `/v3/application/listings/{id}/inventory` with one Etsy product per Printify variant (size × color, custom-properties path) so buyers can pick a size on Etsy. Mapping in `packages/shared/src/etsy-inventory.ts`.
10. Upload Printify mockups to Etsy listing — each call carries an `alt_text` derived from the title. PATCH to `active`. Flip Printify `is_visible=true`. Write `etsy_listing_id`, `is_active=true`.

Etsy API notes: OAuth 2.0 (1-hour token expiry — refresh helper required); `taxonomy_id` lookup table per niche; one reusable `shipping_profile_id`.

**Mock mode (Etsy bridge).** Set `ETSY_MOCK_MODE=true` to short-circuit every Etsy v3 call (token refresh, taxonomy, create-draft, image upload, inventory PUT, activate) and return canned fixtures from `packages/shared/src/etsy-mock.ts`. The full publish pipeline runs end-to-end against real Supabase + real Printify with no Etsy credentials needed. Flip to `false` (and rotate the four OAuth fields off the literal `"mock"` placeholder, which `config.ts` rejects as a safety check) the moment real creds land. The dashboard's listing-detail page renders an "Etsy payload preview" panel showing exactly what each call would POST/PUT.

### Agent 4 — Ledger (`packages/ledger/`)
Two crons: receipt polling (every 30 min) and a daily digest. **Metrics-only — never calls Printify.** Order fulfillment is handled by Etsy's native Printify integration outside this codebase.

1. Receipt poller: `GET /receipts?was_paid=true` (limit 100). Idempotency comes from the UNIQUE constraint on `orders.etsy_order_id` — re-scanning the same window every tick is safe.
2. For each receipt: compute `sale_price` (buyer currency) + `sale_price_usd` (normalized), `etsy_fees_usd` (formula in `economics.ts`), and best-effort `print_cost_usd` from `listings → design_packages → BLUEPRINT_PRINT_COST_USD`. Missing listing → log row with `print_cost_usd = NULL`; missing currency → Slack warn + NULL economics.
3. INSERT into `orders` with `status='logged'`. `margin_usd` is a generated column.
4. Per-order alert: if computed margin drops below `MARGIN_WARNING_THRESHOLD_USD`, fire Slack warning.
5. Daily digest cron: sum the previous UTC day's revenue, fees, print cost, margin, and errored count. Post to Slack and email via Resend.

**Etsy uses "receipts" not "orders"** — always use `/receipts` endpoints.

---

## Coding Standards

- **All secrets via env vars.** No hardcoded values.
- **Idempotent writes.** Prefer upsert over insert where practical.
- **Row locking.** Poll with `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent agent instances don't double-process.
- **Errors:** set `status='error'`, write `error_message`, increment `retry_count`, alert. Recovery model is **per-agent** and depends on whether the work is upstream or downstream of a human gate:
  - **Listing** (downstream of human design approval): auto-requeues — if `retry_count < 3` → back to `pending`; if `≥ 3` → stay in `error`. See `packages/listing/src/publisher.ts`.
  - **Design** (downstream of human brief approval): **does NOT auto-requeue**. A failure parks the brief at `error` and the operator must re-approve in the dashboard. Auto-retry would conflict with the human-gate pattern that runs through every agent's output. See `packages/design/main.py`.
  - **Scout** (pre-approval): writes one error row with `retry_count=1` and relies on the 7-day duplicate-niche suppression as natural backoff — the next cron tick picks the niche back up if and only if no recent error row exists.
  - **Ledger:** receipt-poller failures retry the next tick (every 30 min); per-row writes are idempotent via the `orders.etsy_order_id` UNIQUE constraint.
- **TS:** strict mode; zod for all external data; no `any` (use `unknown` + guards); named exports only (except entry points); `bottleneck` for Etsy rate limits.
- **Python:** type hints everywhere; `httpx` not `requests`; `pydantic` models; `structlog`; never bare `except:`.
- **Logging:** `{ agent, action, record_id, status, duration_ms, error? }` on every action.

---

## Key Business Rules (Non-Negotiable)

1. **Never copy existing designs.** FLUX prompts from style keywords only. Reject + regenerate if Claude names an artist/product.
2. **AI disclosure on every listing.** Exact `AI_DISCLOSURE_TEXT` constant (see compliance section).
3. **Pricing floor:** `price ≥ print_cost × 2.5`. Factor Etsy fees ($0.20 listing + 6.5% txn + 3% + $0.25 processing).
4. **Etsy rate limits:** 10 req/sec, 10k/day. Shared limiter (`bottleneck` TS, `asyncio.Semaphore` Python).
5. **Idempotency:** Ledger relies on the UNIQUE constraint on `orders.etsy_order_id`; re-polling the same receipt is a no-op.
6. **Row locking** on all polling queries (Scout, Design, Listing). Ledger uses unique-constraint dedup instead of row locks.

---

## Etsy Seller Policy Compliance

Six hard gates. All validators in `packages/listing/src/compliance.ts`, throw `ComplianceError`, run twice (pre-Claude + inside `executeEtsyPublish`).

| # | Rule | Enforcement |
|---|---|---|
| 1 | **Production partner disclosure** — `production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID]` required on Etsy listing | `validateProductionPartnerId()`; Zod schema `EtsyListingCreateInputSchema` requires field |
| 2 | **AI disclosure** — `AI_DISCLOSURE_TEXT` (in `packages/shared/src/constants.ts`) must appear verbatim in description | Copywriter prompt + `ListingCopySchema` parse + `validateAiDisclosure()` |
| 3 | **No manual-creation / scarcity language** — see `FORBIDDEN_LISTING_TERMS` (handmade, OOAK, limited edition, etc.). Always `who_made:"i_did"`, `when_made:"made_to_order"`, `is_supply:false` | Copywriter prompt + `validateNoForbiddenTerms()` (strips AI disclosure substring first so "hand-selected" doesn't trip) |
| 4 | **Mockups from actual design** — `design_packages.mockups_from_actual_design` must be `true` | Listing sets flag in same write as `mockup_urls` after `createHiddenProduct()`; `validateMockupProvenance()` re-checks at publish, including resume path |
| 5 | **Single shop** — only `BassetAndBirch` (`ETSY_SHOP_NAME`). Never add second shop/account | Operational rule; one `ETSY_SHOP_ID` only |
| 6 | **No off-platform** — no URLs, `@handles`, no "DM me" / "visit our site" | Copywriter prompt + `validateNoOffPlatform()` (regex `EXTERNAL_URL_PATTERN`, `SOCIAL_HANDLE_PATTERN`, `OFF_PLATFORM_PHRASES`) |

When changing the Listing Agent, copywriter prompt, or publish pipeline, re-verify every rule end to end. Copywriter prompt and validators are a coupled enforcement pair — update both together.

---

## Etsy OAuth 2.0

- Register app at https://www.etsy.com/developers/register. Scopes: `listings_w`, `listings_r`, `transactions_r`, `shops_r`.
- **Access tokens expire every 1 hour.** Refresh via POST `https://api.etsy.com/v3/public/oauth/token` with `grant_type=refresh_token`.
- Store tokens in Supabase `config` table (not env vars — they rotate too often).
- All Etsy calls must go through a `refreshEtsyToken()` helper that checks expiry first.

---

## Per-Unit Economics

Reference: Gildan 64000 tee (base $8.50, shipping $4.50 US). Etsy fees: $0.20 listing + 6.5% txn + 3% + $0.25 processing.

- **$24.99:** ~$2.12 fees → net ~$9.87 (39.5%)
- **$19.99:** net ~$5.18 (25.9%)
- **<$16.99:** unprofitable

`2.5×` floor is a minimum, not a target. Aim for 3× when the niche supports it.

---

## Printify API Compliance

The Listing Agent still calls Printify (product create + publish flip). Order creation, webhook ingestion, and tracking sync no longer exist — Etsy's native Printify integration handles those. Rules below apply to the Listing call path:

- **Single shared client:** `packages/shared/src/printify-http.ts`. No new `fetch()` calls to Printify outside this module.
- **Headers:** `Content-Type: application/json;charset=utf-8`, `User-Agent: presswork/<version>`, `Authorization: Bearer ${PRINTIFY_API_TOKEN}`.
- **Rate limits:** Global 600/min (`maxConcurrent: 4, minTime: 110`). Publishing 200/30min (`reservoir: 180/30min`, tag `{ rateClass: "publishing" }`). Parse `Retry-After` on 429, retry ≤ 3.
- **Error-rate guard:** ring buffer of last 200 requests. `GET /healthz/printify` returns `{ ok, error_rate_4xx_pct, error_rate_5xx_pct, sample_size }`. `ok=false` at ≥4% combined (one under Printify's 5% threshold). Surfaced via the Listing service's health endpoint, not Ledger.

---

## Testing

| Language | Framework | HTTP mocking |
|---|---|---|
| TS | Vitest | MSW |
| Python | pytest + `pytest-asyncio` (+ `pytest-mock`) | respx |
| Integration (DB) | local Supabase via `supabase start` | — |

**Mock at HTTP layer** (Etsy, fal.ai, Printify, Anthropic) — never the SDK call. Validate Claude/fal.ai **response shapes** with Zod/pydantic, not content. Hit a real local Supabase for integration tests — schema + triggers + `FOR UPDATE SKIP LOCKED` are the contract.

Required coverage (do not ship without):
1. Status transition enforcement (no skipping steps) for Scout/Design/Listing
2. Ledger idempotency (same receipt scanned twice → exactly one `orders` row)
3. Pricing floor at exactly `2.5×`
4. Row locking under concurrent pollers
5. Retry budget — after 3 fails, stays `error`, alert fires
6. AI disclosure missing → rejected before Etsy call
7. Ledger currency normalization: non-USD receipts persist both `sale_price` (buyer currency) and `sale_price_usd`

Co-locate tests: `foo.ts` + `foo.test.ts`. Integration tests in `tests/integration/`, gated by `INTEGRATION=1`.

```bash
npm test --workspace=packages/listing
cd packages/scout && pytest
supabase start && INTEGRATION=1 npm test --workspaces
```

---

## Build & Run

```bash
npm install
cd packages/listing && npx ts-node src/index.ts
npm run poll-receipts --workspace=packages/ledger
cd packages/scout && python main.py
cd packages/design && python main.py
npx supabase db push
```

---

## CI/CD

GitHub Actions = **quality gates**. Railway = **deployment** (auto from `main`). Keep separate; don't deploy from Actions.

Workflows in `.github/workflows/`:
- `ci.yml` — PR + push to `main`: lint, typecheck, unit tests
- `integration.yml` — PR to `main` only: integration tests vs local Supabase
- `codeql.yml` — PR + weekly: static security

Required status checks (block merge): lint (eslint + ruff), typecheck (tsc + pyright/mypy), unit tests (Vitest + pytest), integration tests, migration sanity (if `infra/supabase/migrations/**` changed → `supabase db reset` to verify from scratch).

Use `paths:` filters per job (TS-only / Python-only / both for shared + migrations). Cache: `setup-node` with `cache:'npm'`, `setup-python` with `cache:'pip'`, Docker images via `actions/cache`. Targets: <3min unit, <8min integration.

**No live API keys in CI.** All externals mocked. Production secrets live only in Railway. CI needs only `SUPABASE_DB_PASSWORD`.

---

## Railway Deployment

> **PLANNED — NOT ACTIVE.** This is the *future* deployment topology, not the current state. Railway is not deployed and these schedules are **not running**. The schedules in `infra/railway.toml` are commented out; the table below is the target layout for if/when unattended automation is deliberately turned on. See "Automation Status" near the top. Until then, run agents manually via CLI.

| Service | Type | Schedule (planned) |
|---|---|---|
| `scout` | Cron | `0 2 * * *` |
| `design` | Cron | `*/15 * * * *` |
| `listing` | Cron | `*/15 * * * *` |
| `ledger-cron-receipts` | Cron | `*/30 * * * *` |
| `ledger-cron-daily-digest` | Cron | `0 13 * * *` |

Shared env var group across all services. Services communicate only through Supabase.

---

## Open Questions

- [ ] Niche seed list: starting categories?
- [ ] Printify blueprints at launch: tees only, or +mugs/posters?
- [ ] Volume target: listings/week?
- [ ] When to add Printful as secondary for redundancy?

---

## Claude Code Tooling (ECC plugin)

Plugin installed at `~/.claude/`. Invoke commands directly (`/plan`, `/code-review`); skills auto-match by trigger.

**Most relevant skills:** `supabase`, `supabase-postgres-best-practices`, `python-patterns`, `python-testing`, `postgres-patterns`, `database-migrations`, `agent-harness-construction`, `agent-eval`, `agent-introspection-debugging`, `prompt-optimizer`, `cost-aware-llm-pipeline`, `claude-api`, `tdd-workflow`, `security-review`, plus repo-local `etsy` and `printify` skills (authoritative — leave alone).

**Useful commands:** `/plan`, `/feature-dev`, `/code-review`, `/python-review`, `/security-review`, `/test-coverage`, `/database-migration`, `/build-fix`, `/simplify`.

**Useful subagents:** `planner`, `python-reviewer`, `typescript-reviewer`, `database-reviewer`, `security-reviewer`, `silent-failure-hunter` (especially relevant given retry/status-error logic), `tdd-guide`.

Reinstall: `node /Users/brac/Work/everythingClaudeCode/scripts/install-apply.js --profile developer --target claude`. Managed paths under `~/.claude/rules/ecc/` and `~/.claude/skills/ecc/`; anything outside `ecc/` is user-owned.
