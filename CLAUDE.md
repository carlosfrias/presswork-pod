# CLAUDE.md — Etsy AI Agent Pipeline

Source of truth for Claude Code on this project. Read fully before changing anything.

---

## Project Overview

Autonomous 4-agent print-on-demand pipeline on Etsy + Printify:

1. **Scout** (Python) — scans Etsy for trends → `trend_briefs`
2. **Design** (Python) — generates art via fal.ai FLUX Pro → `design_packages`
3. **Listing** (TS) — publishes SEO listings via Etsy API v3 → `listings`
4. **Fulfillment** (TS) — webhook server, Printify routing, tracking → `orders`

Agents are **loosely coupled via Supabase**. No direct agent-to-agent calls — each reads inputs and writes outputs through DB tables.

---

## Monorepo Structure

npm workspaces; Python packages own their `requirements.txt`.

- `packages/shared/` — TS lib (Supabase client, types, logger, zod config, HTTP clients)
- `packages/shared-py/` — Python lib (pydantic, supabase-py, config, structlog)
- `packages/scout/` — Agent 1 (Python)
- `packages/design/` — Agent 2 (Python)
- `packages/listing/` — Agent 3 (TS) — `compliance.ts` is the policy gate
- `packages/fulfillment/` — Agent 4 (TS) — Express webhook server
- `infra/supabase/migrations/` — SQL migrations (`001_*.sql` …) — **schema lives here, not in this file**
- `infra/railway.toml` — Railway service definitions
- `scripts/` — one-off ops scripts

---

## Tech Stack

| Layer | Tool |
|---|---|
| Scout + Design | Python 3.12 (`httpx`, `pydantic`, `structlog`) |
| Listing + Fulfillment | TypeScript / Node 20 (strict mode, `zod`, `bottleneck`) |
| AI reasoning | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| Image gen | fal.ai FLUX Pro 1.1 (~$0.05/image) |
| Database | Supabase (Postgres) — agent handoff state |
| Storage | Supabase Storage — design PNGs, mockups |
| Hosting / cron | Railway (one service per agent) |
| Print fulfillment | Printify (primary) |
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
PRINTIFY_API_TOKEN= PRINTIFY_SHOP_ID=
PRINTIFY_WEBHOOK_BASE_URL= PRINTIFY_WEBHOOK_SECRET=
SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY=    # service role only, never anon in backend
RESEND_API_KEY= ALERT_EMAIL= SLACK_WEBHOOK_URL=
NODE_ENV=development LOG_LEVEL=info
HUMAN_REVIEW_ENABLED=true     # false to skip manual review on listings
```

---

## Database Schema

Full DDL lives in `infra/supabase/migrations/`. Four core tables drive agent handoffs:

| Table | Owner | Status flow |
|---|---|---|
| `trend_briefs` | Scout writes, Design reads | `pending` → `processing` → `done` \| `error` |
| `design_packages` | Design writes, Listing reads | `pending` → `processing` → `done` \| `error` |
| `listings` | Listing | `pending` → `needs_review` → `publishing` → `active` \| `error` |
| `orders` | Fulfillment | `received` → `submitted` → `shipped` \| `error` |

Rules:
- **Never skip a status step.** Enforce transitions in code.
- `listings`: if `HUMAN_REVIEW_ENABLED=true`, pause at `needs_review`; otherwise straight to `publishing`.
- `orders.margin_usd` is a generated column: `sale_price − print_cost − etsy_fees`.
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
5. Dedupe vs last 7 days. Insert with `status='pending'`.

### Agent 2 — Design (`packages/design/`)
Polls every 15 min for `trend_briefs.status='pending'`.

1. Claim row → `processing`.
2. Claude Sonnet crafts FLUX-safe prompt (always append: `"print on demand design, transparent background, high resolution, vector-style"`; never artist/brand/IP names).
3. fal.ai FLUX Pro 1.1 (`square_hd`, png, `safety_tolerance=2`) → image URL.
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
7. If `HUMAN_REVIEW_ENABLED=true`: pause at `needs_review`. Owner approves → status `pending_publish`.
8. On publish (`executeEtsyPublish`): re-run full compliance gate (defense-in-depth). Create Etsy draft with `production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID]`, `who_made:"i_did"`, `when_made:"made_to_order"`, `is_supply:false`.
9. Upload Printify mockups to Etsy listing. PATCH to `active`. Flip Printify `is_visible=true`. Write `etsy_listing_id`, `is_active=true`.

Etsy API notes: OAuth 2.0 (1-hour token expiry — refresh helper required); `taxonomy_id` lookup table per niche; one reusable `shipping_profile_id`.

### Agent 4 — Fulfillment (`packages/fulfillment/`)
Always-on Express server on `$PORT`.

1. `POST /webhook/etsy-order`: verify HMAC-SHA256 with `ETSY_API_SECRET`.
2. Idempotency: lookup `orders` by `etsy_order_id`; skip if exists.
3. Resolve `listings` → `design_packages` → blueprint/variant IDs.
4. Insert `orders` row (`status='received'`).
5. POST to Printify with `external_id: etsyReceiptId` (Printify-side idempotency) + `label: etsy-${id}`. Status → `submitted`.
6. `POST /webhook/printify-order`: verify HMAC-SHA256 (base64) with `PRINTIFY_WEBHOOK_SECRET`. Handles `order:updated`, `order:shipment:created`. On boot, `registerPrintifyWebhooks()` ensures subscriptions exist.
7. On shipped: update `tracking_*`, PATCH Etsy receipt with tracking.
8. On error: status `error`, log to `error_message`, Slack alert.

**Etsy uses "receipts" not "orders"** — always use `/receipts` endpoints. Etsy webhooks are unreliable; `tracking-poller.ts` cron polls `GET /receipts?was_paid=true&was_shipped=false` as safety net (interval can be relaxed to 4h once webhooks verified).

---

## Coding Standards

- **All secrets via env vars.** No hardcoded values.
- **Idempotent writes.** Prefer upsert over insert where practical.
- **Row locking.** Poll with `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent agent instances don't double-process.
- **Errors:** set `status='error'`, write `error_message`, increment `retry_count`. If `retry_count < 3` → back to `pending`. If `≥ 3` → stay in `error`, alert.
- **TS:** strict mode; zod for all external data; no `any` (use `unknown` + guards); named exports only (except entry points); `bottleneck` for Etsy rate limits.
- **Python:** type hints everywhere; `httpx` not `requests`; `pydantic` models; `structlog`; never bare `except:`.
- **Logging:** `{ agent, action, record_id, status, duration_ms, error? }` on every action.

---

## Key Business Rules (Non-Negotiable)

1. **Never copy existing designs.** FLUX prompts from style keywords only. Reject + regenerate if Claude names an artist/product.
2. **AI disclosure on every listing.** Exact `AI_DISCLOSURE_TEXT` constant (see compliance section).
3. **Pricing floor:** `price ≥ print_cost × 2.5`. Factor Etsy fees ($0.20 listing + 6.5% txn + 3% + $0.25 processing).
4. **Etsy rate limits:** 10 req/sec, 10k/day. Shared limiter (`bottleneck` TS, `asyncio.Semaphore` Python).
5. **Idempotency:** double-fired webhook must detect existing `printify_order_id` and skip.
6. **Row locking** on all polling queries.

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

Implemented in Steps 1–5 of `PLAN_PRINTIFY_API_COMPLIANCE.md`. Must not regress:

- **Single shared client:** `packages/shared/src/printify-http.ts`. No new `fetch()` calls to Printify outside this module.
- **Headers:** `Content-Type: application/json;charset=utf-8`, `User-Agent: presswork/<version>`, `Authorization: Bearer ${PRINTIFY_API_TOKEN}`.
- **Rate limits:** Global 600/min (`maxConcurrent: 4, minTime: 110`). Publishing 200/30min (`reservoir: 180/30min`, tag `{ rateClass: "publishing" }`). Parse `Retry-After` on 429, retry ≤ 3.
- **Idempotency:** `createOrder()` sends `external_id: etsyReceiptId` + `orders.etsy_order_id UNIQUE` constraint.
- **Webhooks primary, polling backup.** Handler in `packages/fulfillment/src/printify-webhook.ts`. Re-delivered events for unchanged status are no-ops (200 + `skipped`).
- **Error-rate guard:** ring buffer of last 200 requests. `GET /healthz/printify` returns `{ ok, error_rate_4xx_pct, error_rate_5xx_pct, sample_size }`. `ok=false` at ≥4% combined (one under Printify's 5% threshold).

---

## Testing

| Language | Framework | HTTP mocking |
|---|---|---|
| TS | Vitest (+ `supertest` for fulfillment) | MSW |
| Python | pytest + `pytest-asyncio` (+ `pytest-mock`) | respx |
| Integration (DB) | local Supabase via `supabase start` | — |

**Mock at HTTP layer** (Etsy, fal.ai, Printify, Anthropic) — never the SDK call. Validate Claude/fal.ai **response shapes** with Zod/pydantic, not content. Hit a real local Supabase for integration tests — schema + triggers + `FOR UPDATE SKIP LOCKED` are the contract.

Required coverage (do not ship without):
1. Status transition enforcement (no skipping steps)
2. Webhook idempotency (same payload twice → exactly one row + one Printify call)
3. Pricing floor at exactly `2.5×`
4. HMAC verification: invalid/missing sig → 401; replay rejected
5. Row locking under concurrent pollers
6. Retry budget — after 3 fails, stays `error`, alert fires
7. AI disclosure missing → rejected before Etsy call

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
cd packages/fulfillment && npx ts-node src/index.ts
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

| Service | Type | Schedule |
|---|---|---|
| `scout` | Cron | `0 2 * * *` |
| `design` | Cron | `*/15 * * * *` |
| `listing` | Cron | `*/15 * * * *` |
| `fulfillment` | Web | always-on, `$PORT` |

Shared env var group across all four. Services communicate only through Supabase.

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
