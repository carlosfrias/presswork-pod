# Presswork

An autonomous print-on-demand pipeline for Etsy. Four AI agents — Scout, Design, Listing, and Ledger — hand off to each other through a shared Supabase database to discover trends, generate original artwork, publish listings, and track the financials. Order fulfillment is handled by Etsy's native Printify integration outside this codebase.

---

## How it works

```
Etsy trends → Scout → Design → Listing → (Etsy ↔ Printify fulfillment) → Ledger
                  ↓          ↓         ↓                                    ↓
              trend_briefs  design_   listings                            orders
                           packages
```

**Scout** runs nightly. It scans Etsy for trending niches, calls Claude to extract structured trend briefs (keywords, price targets, color palette), and writes them to `trend_briefs`. Exact-match and semantic dedup via Claude prevent near-duplicate briefs from flooding the pipeline.

**Design** polls every 15 minutes. It picks up pending briefs, calls Claude to craft a FLUX-safe image prompt, generates a 300dpi print-ready PNG via fal.ai (FLUX Pro 1.1), and uploads the result to Supabase Storage. Identical prompts are detected by SHA-256 hash and reuse the prior image rather than paying for a duplicate fal.ai call.

**Listing** polls every 15 minutes. It creates a hidden Printify product to generate mockup images, writes SEO-optimized listing copy via Claude, then publishes to Etsy (draft → images → activate). If `HUMAN_REVIEW_ENABLED=true`, listings pause at `needs_review` for manual approval before going live.

**Ledger** polls Etsy receipts every 30 minutes for paid orders. Each receipt is logged once (idempotent via a unique constraint on `etsy_order_id`) with sale price in buyer currency, USD-normalized total, computed Etsy fees, looked-up print cost, derived margin, and buyer country. A low-margin Slack warning fires per-order; a separate daily cron emits a revenue/margin digest via Slack and email.

---

## Stack

| Layer | Tool |
|---|---|
| Scout + Design | Python 3.12, httpx, pydantic, structlog |
| Listing + Ledger | TypeScript / Node.js 20, Zod, Bottleneck |
| AI reasoning | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| Image generation | fal.ai — FLUX Pro 1.1 |
| Database + Storage | Supabase (Postgres) |
| Print fulfillment | Etsy's native Printify integration (out of band) |
| Hosting + cron | Railway |
| Alerts | Slack incoming webhooks + Resend email |

---

## Repo structure

```
presswork/
├── packages/
│   ├── shared/          # TypeScript — types, Supabase client, Etsy API wrappers, notifier
│   ├── shared_py/       # Python — Pydantic models, Supabase client, config, notifier
│   ├── scout/           # Agent 1 (Python) — Etsy trend scraper
│   ├── design/          # Agent 2 (Python) — fal.ai image generation
│   ├── listing/         # Agent 3 (TypeScript) — Etsy listing publisher
│   └── ledger/          # Agent 4 (TypeScript) — receipt polling + economics digest
├── infra/
│   ├── railway.toml
│   └── supabase/migrations/
├── tests/e2e/           # Full-pipeline smoke test
└── .github/workflows/   # CI — lint, typecheck, unit tests
```

---

## Local setup

**Requirements:** Node.js 20+, Python 3.12, [Supabase CLI](https://supabase.com/docs/guides/cli)

```bash
# Clone and install
git clone https://github.com/brac/presswork
cd presswork
npm install

# Python virtualenv
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r packages/scout/requirements-dev.txt
pip install -r packages/design/requirements-dev.txt
pip install -r packages/shared_py/requirements-dev.txt

# Copy and fill in environment variables
cp .env.example .env
```

### Start local Supabase

```bash
supabase start          # spins up local Postgres + Storage
supabase db reset       # applies all migrations from scratch
```

---

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `ETSY_API_KEY` / `ETSY_API_SECRET` | Etsy app credentials |
| `ETSY_SHOP_ID` | Your Etsy shop ID |
| `ETSY_ACCESS_TOKEN` / `ETSY_REFRESH_TOKEN` | OAuth tokens (rotate hourly) |
| `FAL_KEY` | fal.ai API key |
| `PRINTIFY_API_TOKEN` / `PRINTIFY_SHOP_ID` | Printify credentials |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase project |
| `SLACK_WEBHOOK_URL` | Incoming webhook for error alerts (optional) |
| `HUMAN_REVIEW_ENABLED` | `true` to pause listings before publishing (default) |

---

## Running agents manually

```bash
# Scout — discover trends and write trend_briefs
python -m packages.scout.main

# Design — generate images for pending briefs
python -m packages.design.main

# Listing — publish designs to Etsy
npx tsx packages/listing/src/index.ts

# Ledger — poll Etsy receipts and log economics
npm run poll-receipts --workspace=packages/ledger

# Ledger — emit yesterday's revenue digest
npm run daily-digest --workspace=packages/ledger
```

---

## Testing

```bash
# TypeScript unit tests (all packages)
npm test --workspaces --if-present

# Python unit tests
pytest packages/scout packages/design packages/shared_py \
  --ignore=packages/scout/tests/integration \
  --ignore=packages/design/tests/integration

# Integration tests (requires supabase start)
INTEGRATION=1 npm test --workspace=packages/listing

# E2E smoke test (requires supabase start)
INTEGRATION=1 npm run test:e2e
```

All external APIs (Etsy, Printify, fal.ai, Anthropic) are mocked at the HTTP layer in tests via MSW (TypeScript) and respx (Python). No live API keys are needed to run the test suite.

---

## CI

GitHub Actions runs on every push to `main` and every PR:

- **TS job** — ESLint, `tsc --noEmit`, Vitest (shared, listing, ledger)
- **Python job** — ruff, pyright, pytest (scout, design, shared_py)

Integration tests and the E2E smoke test are not run in CI — they require a live Supabase instance and are run locally before merging significant changes.

---

## Database schema

Five tables — agents communicate exclusively through Supabase, never by calling each other directly.

| Table | Written by | Read by |
|---|---|---|
| `trend_briefs` | Scout | Design |
| `design_packages` | Design | Listing |
| `listings` | Listing | Ledger (for print-cost lookup) |
| `orders` | Ledger | — |

Status columns enforce strict one-way transitions (`pending → processing → done / error`). Row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) prevents two agent instances from claiming the same row simultaneously.

---

## Deployment

Each agent runs as a separate Railway service. Railway auto-deploys from `main` on push. Configure environment variables in the Railway dashboard — never commit secrets.

| Service | Type | Schedule |
|---|---|---|
| `scout` | Cron | Nightly at 2am |
| `design` | Cron | Every 15 min |
| `listing` | Cron | Every 15 min |
| `ledger-cron-receipts` | Cron | Every 30 min |
| `ledger-cron-daily-digest` | Cron | Daily at 13:00 UTC |

> **Note:** Etsy API access requires a separate storefront application. The pipeline runs fully against mocks until live credentials are available. Flip `HUMAN_REVIEW_ENABLED=false` only after manually verifying a listing end-to-end in a sandbox shop.

---

## Economics (Gildan 64000 t-shirt)

```
Printify base cost:      ~$8.50
Shipping (US domestic):  ~$4.50
Etsy fees (at $24.99):   ~$2.12
──────────────────────────────
Net margin at $24.99:    ~$9.87  (39%)
Pricing floor:            $21.25  (2.5× print cost)
```
