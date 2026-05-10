# CLAUDE.md — Etsy AI Agent Pipeline

This file is the source of truth for Claude Code when working on this project.
Read it fully before writing any code, suggesting any architecture, or making any changes.

---

## Project Overview

An autonomous 4-agent print-on-demand pipeline built on top of Etsy + Printify.
The system runs with minimal human intervention:

1. **Scout Agent** — scans Etsy for trending niches, keywords, price points, and style signals
2. **Design Agent** — generates original print-ready artwork using those trend signals via fal.ai (FLUX Pro)
3. **Listing Agent** — publishes SEO-optimized Etsy listings with mockup images via Etsy API v3
4. **Fulfillment Agent** — listens for Etsy order webhooks, creates Printify orders, posts tracking back to Etsy

All agents are **loosely coupled via Supabase** (Postgres). Each agent reads its inputs from DB and writes its outputs back. No direct agent-to-agent calls.

---

## Monorepo Structure

```
etsy-agent/
├── CLAUDE.md                  ← you are here
├── .env.example
├── package.json               ← root workspace (npm workspaces)
│
├── packages/
│   ├── shared/                ← shared TS types, db client, logger, config
│   │   ├── src/
│   │   │   ├── db.ts          ← Supabase client singleton
│   │   │   ├── types.ts       ← shared interfaces (TrendBrief, DesignPackage, Order)
│   │   │   ├── logger.ts      ← pino logger
│   │   │   └── config.ts      ← zod-validated env vars
│   │   └── package.json
│   │
│   ├── shared-py/             ← shared Python models, db client, config
│   │   ├── models.py          ← Pydantic models mirroring types.ts
│   │   ├── db.py              ← supabase-py client singleton
│   │   ├── config.py          ← pydantic-settings env parsing
│   │   ├── logger.py          ← structlog config
│   │   └── requirements.txt
│   │
│   ├── scout/                 ← Agent 1 (Python)
│   │   ├── main.py
│   │   ├── etsy_client.py
│   │   ├── analyzer.py        ← Claude Sonnet call to extract trend brief
│   │   ├── requirements.txt
│   │   └── README.md
│   │
│   ├── design/                ← Agent 2 (Python)
│   │   ├── main.py
│   │   ├── prompt_builder.py  ← Claude Sonnet → FLUX prompt
│   │   ├── fal_client.py      ← fal.ai image generation
│   │   ├── image_processor.py ← resize, 300dpi, transparent bg
│   │   ├── requirements.txt
│   │   └── README.md
│   │
│   ├── listing/               ← Agent 3 (TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── etsy-api.ts
│   │   │   ├── copywriter.ts  ← Claude Sonnet → title, description, tags
│   │   │   ├── mockup.ts      ← Printify mockup generation
│   │   │   └── publisher.ts   ← assembles and posts listing
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── fulfillment/           ← Agent 4 (TypeScript)
│       ├── src/
│       │   ├── index.ts       ← Express webhook server
│       │   ├── etsy-webhook.ts
│       │   ├── printify-api.ts
│       │   ├── order-router.ts
│       │   └── notifier.ts    ← Slack + Resend alerts
│       ├── tsconfig.json
│       └── package.json
│
├── infra/
│   ├── railway.toml           ← service definitions
│   └── supabase/
│       └── migrations/        ← SQL migration files
│           ├── 001_trend_briefs.sql
│           ├── 002_design_packages.sql
│           ├── 003_listings.sql
│           └── 004_orders.sql
│
└── scripts/
    ├── seed-niches.ts         ← populate initial niche seeds
    └── backfill-mockups.ts
```

---

## Tech Stack

| Layer | Tool | Notes |
|---|---|---|
| Scout + Design agents | **Python 3.12** | Better AI/scraping ecosystem |
| Listing + Fulfillment agents | **TypeScript / Node.js 20** | Familiar, great for API wrappers |
| AI reasoning | **Claude Sonnet 4** (`claude-sonnet-4-20250514`) | All agent "thinking" calls |
| Image generation | **fal.ai + FLUX Pro 1.1** | ~$0.05/image, best POD quality |
| Database | **Supabase** (Postgres) | Agent handoff state, order tracking |
| File storage | **Supabase Storage** | Design PNGs, mockup images |
| Hosting / cron | **Railway** | One service per agent |
| Print fulfillment | **Printify** (primary) | Better margins than Printful |
| Mockups | **Printify Mockup API** | Auto-generate listing photos |
| Alerts | **Resend** (email) + Slack webhooks | Failed orders, daily digest |
| Secrets | **Railway env vars** | Never in code or `.env` committed |

---

## Environment Variables

All required vars. Use `.env.example` as template. Never commit actual values.

```bash
# Anthropic
ANTHROPIC_API_KEY=

# Etsy
ETSY_API_KEY=
ETSY_API_SECRET=
ETSY_SHOP_ID=
ETSY_ACCESS_TOKEN=          # OAuth 2.0, refresh manually or via refresh flow
ETSY_REFRESH_TOKEN=
ETSY_PRODUCTION_PARTNER_ID= # Numeric ID from Etsy Shop Manager → Production Partners (Printify). Required.

# fal.ai
FAL_KEY=

# Printify
PRINTIFY_API_TOKEN=
PRINTIFY_SHOP_ID=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=  # service role only, never anon key in backend

# Alerts
RESEND_API_KEY=
ALERT_EMAIL=
SLACK_WEBHOOK_URL=

# Runtime
NODE_ENV=development
LOG_LEVEL=info
HUMAN_REVIEW_ENABLED=true    # set false to skip manual review gate on listings
```

---

## Database Schema (Supabase / Postgres)

These tables are the **backbone of agent handoffs**. Always read/write through these — not direct function calls between agents.

```sql
-- 001: Scout output
CREATE TABLE trend_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending', -- pending → processing → done | error
  niche TEXT NOT NULL,
  style_keywords TEXT[],
  top_tags TEXT[],
  price_target_usd NUMERIC,
  color_palette TEXT[],
  raw_etsy_data JSONB,
  claude_analysis JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0
);
CREATE INDEX idx_trend_briefs_status ON trend_briefs(status);

-- 002: Design Agent output
CREATE TABLE design_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  trend_brief_id UUID REFERENCES trend_briefs(id),
  status TEXT DEFAULT 'pending', -- pending → processing → done | error
  image_url TEXT,              -- Supabase Storage URL (300dpi PNG)
  mockup_urls TEXT[],
  printify_blueprint_id INT,   -- product type ID in Printify catalog
  printify_variant_ids INT[],  -- size/color variants to list
  fal_prompt TEXT,             -- store prompt for audit/iteration
  mockups_from_actual_design BOOLEAN NOT NULL DEFAULT false, -- compliance rule 4
  metadata JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0
);
CREATE INDEX idx_design_packages_status ON design_packages(status);

-- 003: Listing Agent output
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  design_package_id UUID REFERENCES design_packages(id),
  status TEXT DEFAULT 'pending', -- pending → needs_review → publishing → active | error
  etsy_listing_id BIGINT UNIQUE,
  title TEXT,
  description TEXT,
  tags TEXT[],
  price_usd NUMERIC,
  is_active BOOLEAN DEFAULT false,
  error_message TEXT,
  retry_count INT DEFAULT 0
);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_etsy_id ON listings(etsy_listing_id);

-- 004: Fulfillment Agent
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  etsy_order_id TEXT UNIQUE NOT NULL,
  listing_id UUID REFERENCES listings(id),
  status TEXT DEFAULT 'received', -- received → submitted → shipped | error
  printify_order_id TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  sale_price_usd NUMERIC,
  print_cost_usd NUMERIC,
  etsy_fees_usd NUMERIC,        -- transaction + processing + listing fees
  margin_usd NUMERIC GENERATED ALWAYS AS (
    sale_price_usd - COALESCE(print_cost_usd, 0) - COALESCE(etsy_fees_usd, 0)
  ) STORED,
  buyer_country TEXT,
  error_message TEXT,
  error_log JSONB
);
CREATE INDEX idx_orders_status ON orders(status);

-- Trigger to auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trend_briefs_updated BEFORE UPDATE ON trend_briefs FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_design_packages_updated BEFORE UPDATE ON design_packages FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_listings_updated BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_timestamp();
```

### Status Transitions (enforce in code — never skip a step)

```
trend_briefs:    pending → processing → done
                                      → error (retry up to 3x, then leave in error)

design_packages: pending → processing → done
                                      → error

listings:        pending → needs_review → publishing → active
                                                     → error
                 (if HUMAN_REVIEW_ENABLED=true, listings pause at needs_review)
                 (if HUMAN_REVIEW_ENABLED=false, skip straight to publishing)

orders:          received → submitted → shipped
                                      → error (alert immediately)
```

---

## Agent Specifications

### Agent 1 — Scout (`packages/scout/`)

**Runtime:** Python cron, fires nightly (Railway cron schedule)
**Goal:** Produce 3–5 `trend_briefs` rows per run

**Logic flow:**
1. Load niche seed list from Supabase `config` table (or hardcoded initially)
2. Call Etsy API: `GET /listings/active` filtered by `sort_on=score`, iterate top results
3. Extract: title keywords, tags, price, review count, shop age
4. Call Claude Sonnet with raw listing data → structured `TrendBrief` JSON
5. Deduplicate: check if a `trend_briefs` row with same niche + similar keywords exists in last 7 days — skip if so
6. Insert into `trend_briefs` with `status = 'pending'`

**Claude call shape:**
```python
system = """You are a print-on-demand market analyst.
Given raw Etsy listing data, extract a structured trend brief.
Respond ONLY with valid JSON matching this schema:
{
  "niche": str,
  "style_keywords": [str],  // aesthetic descriptors, NOT brand names
  "top_tags": [str],        // 13 max, Etsy tag format
  "price_target_usd": float,
  "color_palette": [str]    // hex or color names
}
Never reference specific shop names, artist names, or existing IP."""
```

**Rate limiting:** Max 5 req/sec to Etsy API. Use `asyncio` with semaphore.

---

### Agent 2 — Design (`packages/design/`)

**Runtime:** Python, polls `trend_briefs` where `status = 'pending'` every 15 min
**Goal:** For each trend brief, generate 1 original design → write `design_packages` row

**Logic flow:**
1. Fetch pending `trend_briefs` row, set status → `processing`
2. Call Claude Sonnet → craft FLUX image generation prompt
3. Call fal.ai FLUX Pro 1.1 → get image URL
4. Download image, process to 300dpi transparent-bg PNG via **Pillow** (Python)
5. Upload to Supabase Storage (`designs/` bucket)
6. Insert `design_packages` row (with `printify_blueprint_id` + `printify_variant_ids` declaring intended product), update `trend_briefs.status = 'done'`

Note: Mockup generation is the **Listing Agent's** responsibility, not Design's. Printify has no standalone "generate mockup" endpoint — mockups only exist as a side-effect of creating a Printify product, which Listing already needs to do. Design ends at "print-ready PNG uploaded + DB row written"; `design_packages.mockup_urls` and the `mockups_from_actual_design` provenance flag are populated later by Listing. See `## Etsy Seller Policy Compliance` rule 4 for why the provenance flag exists.

**FLUX prompt rules (enforce strictly):**
- Always: `"print on demand design, transparent background, high resolution, vector-style"`
- Never include: artist names, brand names, living people, copyrighted characters
- Claude's job is to translate `style_keywords` into FLUX-safe descriptive prompts

**fal.ai call:**
```python
result = fal_client.run(
    "fal-ai/flux-pro/v1.1",
    arguments={
        "prompt": flux_prompt,
        "image_size": "square_hd",  # 1024x1024
        "num_images": 1,
        "output_format": "png",
        "safety_tolerance": "2"
    }
)
```

---

### Agent 3 — Listing (`packages/listing/`)

**Runtime:** TypeScript, polls `design_packages` where `status = 'done'` every 15 min
**Goal:** For each completed design package, create Etsy listing → write `listings` row

**Logic flow:**
1. Fetch `design_packages` where `status = 'done'` + joined `trend_briefs`
2. Validate: `price_usd >= print_cost × 2.5` — reject if under floor (`pricing.ts → validatePricingFloor`)
3. Validate: `ETSY_PRODUCTION_PARTNER_ID` is set (`compliance.ts → validateProductionPartnerId`) — fail fast before spending Claude tokens
4. Call Claude Sonnet → generate title, description, tags as structured JSON. The system prompt enforces the AI disclosure, forbidden-terms blocklist, and no-off-platform rules — see `## Etsy Seller Policy Compliance`
5. Validate copy compliance (`compliance.ts → validateCopyCompliance`): AI disclosure present verbatim, no forbidden terms in title/description/tags, no external URLs/handles/off-platform phrasing. Hard reject on failure.
6. **Create the Printify product** (POST `/v1/shops/{shop_id}/products.json`) using `image_url` + `printify_blueprint_id` + `printify_variant_ids` from the design_packages row. Set `is_visible=false` so it stays a draft on Printify until Etsy publishing succeeds. Read the auto-generated mockup image URLs from the response and write them back to `design_packages.mockup_urls`, AND set `mockups_from_actual_design = true` in the same write — these mockups by construction depict our actual design (compliance rule 4).
7. If `HUMAN_REVIEW_ENABLED=true`: set `listings.status = 'needs_review'` and stop. Owner approves via admin script or future dashboard, advancing status to `pending_publish`.
8. If `HUMAN_REVIEW_ENABLED=false` (or on resume after approval): re-run the full compliance gate inside `executeEtsyPublish()` (defense-in-depth) and create draft listing via Etsy API (POST `/application/shops/{shop_id}/listings`) with `production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID]`, `who_made: "i_did"`, `when_made: "made_to_order"`, `is_supply: false`
9. Upload the Printify mockup images to the Etsy listing (POST `/application/shops/{shop_id}/listings/{id}/images`)
10. Activate listing (PATCH status to `active`); flip the Printify product to `is_visible=true`
11. Update `listings` row with `etsy_listing_id`, set `is_active = true`

**Claude copywriting prompt:** the production system prompt lives in `packages/listing/src/copywriter.ts`. It instructs Claude to produce JSON `{title, description, tags}` and enumerates the four Etsy seller-policy rules it must obey (AI disclosure, no manual-creation language, no false uniqueness/scarcity, no off-Etsy redirection). Update both the prompt and the corresponding validators in `compliance.ts` together — they are a coupled enforcement pair.

**Etsy API notes:**
- OAuth 2.0 — access token expires every hour, implement refresh flow
- `taxonomy_id` required — map niche → Etsy taxonomy ID in a lookup table
- `shipping_profile_id` — create one standard profile manually, reuse the ID
- `production_partner_ids` required — `[ETSY_PRODUCTION_PARTNER_ID]`; see compliance rule 1
- `who_made: "i_did"`, `when_made: "made_to_order"`, `is_supply: false`

---

### Agent 4 — Fulfillment (`packages/fulfillment/`)

**Runtime:** TypeScript Express server, always-on Railway service
**Goal:** Receive Etsy orders → create Printify orders → post tracking back

**Logic flow:**
1. Receive POST webhook from Etsy (`/webhook/etsy-order`)
2. Verify webhook signature (HMAC-SHA256 with `ETSY_API_SECRET`)
3. **Idempotency check:** look up `orders` by `etsy_order_id` — if exists, skip
4. Look up `listings` row by `etsy_listing_id` → get `design_package_id`
5. Look up Printify blueprint/variant IDs from `design_packages`
6. Insert `orders` row with `status = 'received'`
7. POST order to Printify API, update `status = 'submitted'`
8. Poll Printify order status every 30 min via Railway cron
9. When shipped: update `orders.tracking_*`, PATCH Etsy receipt with tracking
10. On any error: set `status = 'error'`, log to `orders.error_message`, send Slack alert

**Critical Etsy webhook caveat:**
Etsy webhook support is limited. As of 2024, webhooks only cover certain events and
can be unreliable. **Build a polling fallback:** run a cron every 5 min that calls
`GET /application/shops/{shop_id}/receipts` with `was_paid=true&was_shipped=false`
and processes any receipts not already in the `orders` table. This is your safety net.

**Etsy uses "receipts" not "orders" in their API.** A receipt is a completed transaction.
Always use the Receipts endpoints (`/receipts`) not the legacy Orders endpoints.

**Printify order shape:**
```typescript
{
  label: `etsy-${etsyOrderId}`,
  line_items: [{
    blueprint_id: blueprintId,
    variant_id: variantId,
    print_areas: { front: { src: imageUrl } },
    quantity: lineItem.quantity
  }],
  shipping_method: 1, // standard
  address_to: {
    first_name, last_name, email,
    address1, city, state, country, zip
  }
}
```

---

## Coding Standards

### General
- All secrets via env vars. No hardcoded values ever.
- Every agent must handle errors gracefully: set `status = 'error'`, write to `error_message` column, and increment `retry_count` before exiting
- Prefer explicit over clever. This is a money-making system — clarity beats cleverness.
- All DB writes must be idempotent where possible (upsert over insert when practical)
- Use `SELECT ... FOR UPDATE SKIP LOCKED` when polling for pending rows to avoid two agent instances processing the same row

### Error Handling & Retries
```
On error:
  1. Set row status = 'error'
  2. Write error details to error_message column
  3. Increment retry_count
  4. If retry_count < 3: set status back to 'pending' (will be retried on next poll)
  5. If retry_count >= 3: leave in 'error' status, send alert
```

### TypeScript (Listing + Fulfillment)
- Strict mode on (`"strict": true` in tsconfig)
- Zod for all external data validation (Etsy webhooks, API responses)
- No `any`. Use `unknown` + type guards if shape is uncertain.
- Prefer `async/await` over raw Promise chains
- Named exports only — no default exports except entry points
- Use `bottleneck` for Etsy API rate limiting

### Python (Scout + Design)
- Type hints on all functions
- `httpx` for async HTTP (not `requests`)
- `pydantic` for data models and validation
- `structlog` for structured logging
- Never use bare `except:` — always catch specific exceptions

### Logging
Every agent action must log:
```
{ agent, action, record_id, status, duration_ms, error? }
```

---

## Testing

### Tooling

| Language | Framework | HTTP mocking | Notes |
|---|---|---|---|
| TypeScript (listing, fulfillment) | **Vitest** | **MSW** (Mock Service Worker) | Use `supertest` for the fulfillment Express webhook server |
| Python (scout, design) | **pytest** + `pytest-asyncio` | **respx** (works with `httpx`) | Use `pytest-mock` for non-HTTP mocks |
| Integration (DB) | local Supabase via `supabase start` | — | Spins up real Postgres + Storage; tests run against it |

No Playwright, no Cypress — there is no browser UI in this system.

### What to mock vs. hit for real

- **Always mock at the HTTP layer:** Etsy, fal.ai, Printify, Anthropic. Never hit these in tests.
  - Stub the *response shape* (status code, headers, JSON body), not the SDK call. Catches breakage when SDKs change.
- **Hit a real local Supabase** for integration tests. Mocking the DB defeats the point — the schema, triggers, and `FOR UPDATE SKIP LOCKED` semantics ARE the contract.
- **Validate Claude/fal.ai response *shapes*, not content.** Use Zod (TS) or pydantic (Python) parsers and assert parsing succeeds. The text is nondeterministic; the structure is not.

### Required test coverage (do not ship without these)

1. **Status transition enforcement** — agents must not skip steps. Test that a `pending` row cannot jump to `done` without passing through `processing`.
2. **Idempotency** — fire the same Etsy webhook payload twice; assert exactly one `orders` row and one Printify call.
3. **Pricing floor** — `price_usd < print_cost × 2.5` must reject before any Etsy API call. Test the boundary at exactly `2.5×`.
4. **Webhook HMAC verification** — invalid signature returns 401, not 500. Missing signature returns 401. Replay attacks (old timestamp) rejected.
5. **Row locking** — spin up two concurrent pollers against local Supabase; assert no row is processed twice.
6. **Retry budget** — after 3 failed attempts, row stays in `error` and does NOT flip back to `pending`. Alert is fired.
7. **AI disclosure** — listings without the required disclosure text are rejected before publishing.

### Test layout

Co-locate tests with source:
```
packages/listing/src/copywriter.ts
packages/listing/src/copywriter.test.ts
packages/scout/analyzer.py
packages/scout/test_analyzer.py
```

Integration tests go in `packages/<agent>/tests/integration/` and are gated behind `INTEGRATION=1` so unit runs stay fast.

### Commands

```bash
# TypeScript unit tests
npm test --workspace=packages/listing
npm test --workspace=packages/fulfillment

# Python unit tests
cd packages/scout && pytest
cd packages/design && pytest

# Integration tests (requires local Supabase running)
supabase start
INTEGRATION=1 npm test --workspaces
INTEGRATION=1 pytest packages/scout packages/design

# Stop local Supabase when done
supabase stop
```

### CI

Run unit tests on every push. Run integration tests on PRs to `main` only — they're slower and need the Supabase container.

---

## Build & Run

```bash
# Install all workspaces
npm install

# Run individual agents (dev)
cd packages/listing && npx ts-node src/index.ts
cd packages/fulfillment && npx ts-node src/index.ts

# Python agents
cd packages/scout && python main.py
cd packages/design && python main.py

# Run DB migrations
npx supabase db push
```

---

## CI/CD (GitHub Actions)

GitHub Actions handles **quality gates**. Railway handles **deployment** (auto-deploys from `main` via its native GitHub integration). Keep these concerns separate — do not deploy from Actions.

### Workflows

Live in `.github/workflows/`:

| File | Trigger | Jobs |
|---|---|---|
| `ci.yml` | PR + push to `main` | lint, typecheck, unit tests (TS + Python) |
| `integration.yml` | PR to `main` only | integration tests against local Supabase |
| `codeql.yml` | PR + weekly schedule | static security analysis (TS + Python) |

### Path filtering

The repo is a monorepo with two languages. Use `paths:` filters per job so Python changes don't trigger TS jobs and vice versa. Shared packages (`packages/shared`, `packages/shared-py`, `infra/supabase/migrations/**`) trigger everything.

### Required jobs (block merge to `main`)

Configure as required status checks in the GitHub branch protection rules:

1. **Lint** — `eslint` (TS) + `ruff` (Python)
2. **Typecheck** — `tsc --noEmit` (TS) + `pyright` or `mypy` (Python)
3. **Unit tests** — Vitest + pytest, both must pass
4. **Integration tests** — runs against `supabase start` inside the runner; uses the `supabase/setup-cli` action
5. **Migration sanity** — if any file in `infra/supabase/migrations/**` changed, run `supabase db reset` against local stack to verify migrations apply cleanly from scratch

### Secrets

CI tests must not require live API keys. All external APIs (Etsy, fal.ai, Printify, Anthropic) are mocked at the HTTP layer per the Testing section. The only secret CI needs is `SUPABASE_DB_PASSWORD` for the local stack — set in repo settings.

**Never** put production keys in GitHub Actions secrets. Production secrets live only in Railway.

### Caching

Cache aggressively to keep CI fast:
- `actions/setup-node@v4` with `cache: 'npm'`
- `actions/setup-python@v5` with `cache: 'pip'`
- Cache the Supabase Docker images via `actions/cache` keyed on the Supabase CLI version

Target: <3 min for unit jobs, <8 min for integration.

### Supplementary automation

- **Dependabot** (`.github/dependabot.yml`) — weekly PRs for npm, pip, and GitHub Actions versions. Group minor/patch updates to reduce noise.
- **CodeQL** — auto-detects TS and Python; default config is fine.
- **PR template** (`.github/pull_request_template.md`) — checkboxes for: migrations included, tests added, secrets not committed, Etsy/Printify rate-limit impact considered.

### What CI does NOT do

- **Does not deploy.** Railway watches `main` and deploys on push. If you want pre-deploy gates, use GitHub branch protection — don't move the deploy to Actions.
- **Does not run live API tests.** No real Etsy/Printify/fal.ai calls in CI ever. Smoke-test against real APIs manually before flipping `HUMAN_REVIEW_ENABLED=false`.
- **Does not run cron simulations.** Agent cron schedules are validated by running them locally, not in CI.

---

## Railway Deployment

Four Railway services, one per agent:

| Service | Type | Schedule / Trigger |
|---|---|---|
| `scout` | Cron | `0 2 * * *` (2am nightly) |
| `design` | Cron | `*/15 * * * *` (every 15 min) |
| `listing` | Cron | `*/15 * * * *` (every 15 min) |
| `fulfillment` | Web server | Always-on, listens on `$PORT` |

All services share the same env var group in Railway. No service needs to know about any other service — they communicate only through Supabase.

---

## Key Business Rules (Do Not Violate)

1. **Never copy existing designs.** FLUX prompts must be derived from style keywords only. If Claude identifies a prompt that names a specific artist or existing product, reject and regenerate.
2. **AI-generated art disclosure.** Etsy requires disclosure. Every listing description must include the exact `AI_DISCLOSURE_TEXT` constant from `packages/shared/src/constants.ts`. See `## Etsy Seller Policy Compliance` below for the full rule.
3. **Pricing floor.** Never list below `print_cost × 2.5`. Enforce in `publisher.ts` before listing goes live. Factor in Etsy's 6.5% transaction fee + 3% + $0.25 payment processing fee + $0.20 listing fee.
4. **Etsy rate limits.** Max 10 req/sec, 10,000 req/day. All Etsy API clients must use a shared rate-limiter (use `bottleneck` package in TS, `asyncio.Semaphore` in Python).
5. **Idempotency.** If a webhook fires twice for the same order, the second run must detect the existing `printify_order_id` and skip — never double-order.
6. **Row locking.** When polling for pending rows, use `SELECT ... FOR UPDATE SKIP LOCKED` to prevent two agent instances from grabbing the same row.

---

## Etsy Seller Policy Compliance

These six rules implement Etsy's Seller Policy for AI-generated print-on-demand goods. They are **non-negotiable legal requirements**, not stylistic preferences. Each one is a hard gate enforced in code — listings that fail any check must never reach Etsy's API.

When you change anything in the Listing Agent, the copywriter prompt, or the publish pipeline, re-read this section and verify every rule still holds end to end.

### 1. Production Partner Disclosure (required Etsy API field)

Every Etsy listing must declare Printify as a production partner via the `production_partner_ids` field on the listings endpoint — disclosure in description text alone is insufficient.

- **Setup:** Register Printify in Etsy Shop Manager → Settings → Production Partners. Etsy returns a numeric production-partner ID. Store it in `ETSY_PRODUCTION_PARTNER_ID` (see `.env.example`).
- **Validation:** `validateProductionPartnerId()` in `packages/listing/src/compliance.ts` runs twice per publish (once before any external calls, once immediately before `createDraftListing`). Missing/zero/non-numeric ID throws `ComplianceError` and aborts publishing.
- **Wire-up:** `publisher.ts → executeEtsyPublish()` always passes `production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID]` into `createDraftListing()`. The Zod schema `EtsyListingCreateInputSchema` in `packages/shared/src/etsy-api.ts` requires the field; a missing field is a programmer error caught at parse time.

### 2. AI Disclosure in Every Listing

The exact text in `AI_DISCLOSURE_TEXT` (see `packages/shared/src/constants.ts`) must appear verbatim in every listing description. Currently:

> "This design was created using AI image generation tools, hand-selected and quality-reviewed by our team before printing."

- **Generation:** The Listing Agent's copywriter system prompt (`packages/listing/src/copywriter.ts`) instructs Claude to end every description with this sentence verbatim.
- **Validation (response shape):** `ListingCopySchema` in `packages/shared/src/types.ts` rejects any Claude response whose `description` doesn't contain the disclosure substring. The `CopywriterError` aborts the publish flow.
- **Validation (last-mile):** `validateAiDisclosure()` in `compliance.ts` runs again inside `publisher.ts` after copy generation and again inside `executeEtsyPublish()`, so any path (resume, retry, future code change) that reaches Etsy must satisfy it.

### 3. Listing Copy Restrictions

POD products may not be described as handmade, unique, or scarce. The full forbidden-terms list lives in `FORBIDDEN_LISTING_TERMS` in `packages/shared/src/constants.ts` and includes (case-insensitive, whole-word match):

- Manual-creation claims: `handmade`, `hand-made`, `handcrafted`, `hand-drawn`, `hand-painted`, `hand-sewn`, `hand-stitched` and variants
- False uniqueness/scarcity: `unique`, `one of a kind`, `OOAK`, `limited edition`, `limited availability`, `limited quantity`, `exclusive offer`, `only a few left`, `while supplies last`

Always set on the Etsy create-listing call: `who_made: "i_did"`, `when_made: "made_to_order"`, `is_supply: false`. These are the literal API values that flag a listing as designer-created made-to-order POD on Etsy. Constants live in `packages/listing/src/constants.ts → LISTING_DEFAULTS`.

- **Generation:** Copywriter system prompt explicitly enumerates the forbidden terms and instructs Claude to avoid them.
- **Validation:** `validateNoForbiddenTerms()` in `compliance.ts` scans the title, description, and tags for whole-word matches. Throws `ComplianceError` on any hit. The AI disclosure substring is stripped before scanning so its "hand-selected" wording (selection, not creation) does not trip the manual-creation blocklist.

### 4. Image Requirements (mockups must come from the actual design)

Every listing image must be a Printify mockup generated from the actual design PNG. Generic stock photos and unrelated lifestyle shots are forbidden.

- **Provenance flag:** `design_packages.mockups_from_actual_design BOOLEAN NOT NULL DEFAULT false` (added in `infra/supabase/migrations/007_design_packages_mockups_provenance.sql`).
- **Setting the flag:** The Listing Agent flips it to `true` in the same DB write that populates `mockup_urls`, immediately after `createHiddenProduct()` succeeds — those mockups are by construction Printify-generated from the design's `image_url`.
- **Validation:** `validateMockupProvenance()` in `compliance.ts` runs inside `executeEtsyPublish()` before `createDraftListing()`. If `mockups_from_actual_design` is not `true`, publishing aborts. `resumePublish()` re-reads the flag from the DB so retries cannot bypass it.

### 5. Single Shop Rule

Only one Etsy shop, **`BassetAndBirch`**, is permitted. Never create duplicate shops, alternate accounts, or additional storefronts to circumvent Etsy policies, test different niches, or split product categories. All products go through one shop.

- **Configuration:** `ETSY_SHOP_NAME` constant in `packages/shared/src/constants.ts`. The `ETSY_SHOP_ID` env var must always resolve to this shop.
- **Operational rule:** Do not add a second shop ID, second `ETSY_*_TOKEN` set, or second Printify shop binding. If a future product line needs separation, request a category/tag-based separation inside the existing shop, not a new shop.

### 6. No Off-Platform Transactions

Listing copy may not include external URLs, social-media handles, domain names, or any phrasing that asks buyers to purchase, contact, or follow the seller outside of Etsy.

- **Generation:** Copywriter system prompt forbids URLs, `@username` handles, and off-platform phrasing.
- **Validation:** `validateNoOffPlatform()` in `compliance.ts` checks the combined title/description/tags for `EXTERNAL_URL_PATTERN`, `SOCIAL_HANDLE_PATTERN`, and the `OFF_PLATFORM_PHRASES` blocklist (all in `packages/shared/src/constants.ts`).

### Where each rule is enforced (quick reference)

| Rule | Constant / schema | Validator | Call site |
|---|---|---|---|
| 1. Production partner | `ETSY_PRODUCTION_PARTNER_ID` env, `EtsyListingCreateInputSchema` | `validateProductionPartnerId()` | `publishOne()` + `executeEtsyPublish()` |
| 2. AI disclosure | `AI_DISCLOSURE_TEXT`, `ListingCopySchema` | `validateAiDisclosure()` | copywriter + `executeEtsyPublish()` |
| 3. Forbidden terms | `FORBIDDEN_LISTING_TERMS` | `validateNoForbiddenTerms()` | `validateCopyCompliance()` in `publishOne()` + `executeEtsyPublish()` |
| 4. Mockup provenance | `design_packages.mockups_from_actual_design` | `validateMockupProvenance()` | `executeEtsyPublish()` |
| 5. Single shop | `ETSY_SHOP_NAME`, `ETSY_SHOP_ID` | (operational, not runtime) | All Etsy API wrappers |
| 6. No off-platform | `EXTERNAL_URL_PATTERN`, `SOCIAL_HANDLE_PATTERN`, `OFF_PLATFORM_PHRASES` | `validateNoOffPlatform()` | `validateCopyCompliance()` in `publishOne()` + `executeEtsyPublish()` |

All validators live in `packages/listing/src/compliance.ts` and throw `ComplianceError`, which the publisher treats exactly like `PricingFloorError` — the listing never reaches Etsy.

---

## Etsy OAuth 2.0 Reference

Etsy OAuth is the biggest setup hurdle. Key details:

- **App registration:** https://www.etsy.com/developers/register — request `listings_w`, `listings_r`, `transactions_r`, `shops_r` scopes
- **Access tokens expire every 1 hour.** You MUST implement the refresh flow.
- **Refresh flow:** POST to `https://api.etsy.com/v3/public/oauth/token` with `grant_type=refresh_token`, `client_id`, `refresh_token`
- **Store tokens in Supabase** in a `config` table, not in env vars — they rotate too frequently for static config
- **Build a `refreshEtsyToken()` helper** that checks expiry before every API call and refreshes if needed. Every Etsy API call should go through this helper.

---

## Estimated Per-Unit Economics

For a standard Gildan 64000 t-shirt (most common POD product):

```
Printify base cost:       ~$8.50
Shipping (US domestic):   ~$4.50
Etsy listing fee:          $0.20
Etsy transaction fee (6.5%): variable
Etsy payment processing:   3% + $0.25
───────────────────────────
At $24.99 sale price:
  Revenue:               $24.99
  Print + ship:          $13.00
  Etsy fees:             ~$2.12
  Net margin:            ~$9.87 (39.5%)

At $19.99 sale price:
  Net margin:            ~$5.18 (25.9%)

Below $16.99: unprofitable after fees
```

The pricing floor of `2.5 × print_cost` is a minimum, not a target. Aim for 3× when the niche supports it.

---

## What to Build First (Suggested Order)

1. `packages/shared` + `packages/shared-py` — types, db client, config (unblocks everything)
2. Supabase migrations — get the schema in place, create `designs` storage bucket
3. `packages/scout` — validate you can pull real Etsy trend data and write to `trend_briefs`
4. `packages/design` — validate fal.ai image quality before building listing logic; test with a single trend brief
5. `packages/listing` — needs Etsy OAuth working; start with `HUMAN_REVIEW_ENABLED=true` and create draft (not active) listings
6. `packages/fulfillment` — test with Printify sandbox/test mode before routing real orders
7. Polling fallback cron — the receipt-polling safety net for missed webhooks

Do not skip steps. Each agent is only as good as its inputs.

---

## Open Questions / Decisions Deferred

- [ ] Niche seed list: what categories to start with? (suggest: motivational quotes, pet names, occupations — proven POD winners)
- [ ] Printify blueprint IDs to support at launch: t-shirts only, or mugs + posters too?
- [ ] Volume target: how many listings per week is the goal?
- [ ] At what order volume should Printful be added as a secondary provider for redundancy?