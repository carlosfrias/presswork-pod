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

**Design** polls every 15 minutes. It picks up approved briefs, calls Claude to craft an image prompt (or uses the operator-authored `image_description` verbatim when present), generates a 300dpi print-ready PNG via fal.ai, and uploads the result to Supabase Storage. The image backend is selected per-brief: `fal_gpt_image_2` (OpenAI gpt-image-2, the default), `fal_flux_pro` (FLUX Pro 1.1), or `fal_nano_banana_2` (Gemini-3). Identical prompts are detected by SHA-256 hash and reuse the prior image rather than paying for a duplicate fal.ai call.

**Listing** polls every 15 minutes. It creates a hidden Printify product to generate mockup images, writes SEO-optimized listing copy via Claude, then pauses every listing at `needs_review`. There is no auto-publish path: an operator approves the listing in the dashboard, which flips it to `pending_publish`, and the next Listing run drives the Etsy publish (draft → inventory → images → activate). The full Etsy seller-policy compliance gate runs twice — once before copy generation and again at publish time.

**Ledger** polls Etsy receipts every 30 minutes for paid orders. Each receipt is logged once (idempotent via a unique constraint on `etsy_order_id`) with sale price in buyer currency, USD-normalized total, computed Etsy fees, looked-up print cost, derived margin, and buyer country. A low-margin Slack warning fires per-order; a separate daily cron emits a revenue/margin digest via Slack and email.

---

## Stack

| Layer | Tool |
|---|---|
| Scout + Design | Python 3.12, httpx, pydantic, structlog |
| Listing + Ledger | TypeScript / Node.js 20, Zod, Bottleneck |
| Dashboard | Next.js (TypeScript), Supabase Realtime |
| Scout/Design reasoning | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| Listing copy | Latest flagship Claude — currently Opus 4.8 (`claude-opus-4-8`) |
| Image generation | fal.ai — gpt-image-2 (default), FLUX Pro 1.1, or Gemini-3 (per-brief) |
| Database + Storage | Supabase (Postgres) |
| Print fulfillment | Etsy's native Printify integration (out of band) |
| Hosting + cron | Railway (planned — not deployed; agents currently run manually) |
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
│   ├── ledger/          # Agent 4 (TypeScript) — receipt polling + economics digest
│   └── dashboard/       # Next.js control plane — review gates, manual triggers
├── infra/
│   ├── railway.toml     # planned service definitions (cron schedules commented out)
│   └── supabase/migrations/
├── docs/                # printify integration notes + docs/internal/ planning archive
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
| `ETSY_MOCK_MODE` | `true` runs the full publish flow against canned Etsy fixtures (no Etsy creds needed) |
| `DASHBOARD_ALLOWED_EMAILS` | Comma-separated owner allowlist for dashboard sign-in |

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

Four core tables — agents communicate exclusively through Supabase, never by calling each other directly.

| Table | Written by | Read by |
|---|---|---|
| `trend_briefs` | Scout | Design |
| `design_packages` | Design | Listing |
| `listings` | Listing | Ledger (for print-cost lookup) |
| `orders` | Ledger | — |

Status columns enforce strict one-way transitions (`pending → processing → done / error`). Row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) prevents two agent instances from claiming the same row simultaneously.

---

## Deployment

> **Status: manual only.** Nothing in this system runs on a schedule today. No cron is deployed and no agent fires on its own — every agent is a one-shot, drain-and-exit process invoked by the operator (see "Running agents manually" above). The table below is the *planned* Railway topology for if/when unattended automation is deliberately turned on; the schedules in `infra/railway.toml` are commented out.

The intended layout is one Railway service per agent, auto-deploying from `main` on push, with environment variables configured in the Railway dashboard — never committed.

| Service | Type | Schedule (planned) |
|---|---|---|
| `scout` | Cron | Nightly at 2am |
| `design` | Cron | Every 15 min |
| `listing` | Cron | Every 15 min |
| `ledger-cron-receipts` | Cron | Every 30 min |
| `ledger-cron-daily-digest` | Cron | Daily at 13:00 UTC |

> **Note:** Etsy API access requires a separate storefront application. The pipeline runs fully against mocks (`ETSY_MOCK_MODE=true`) until live credentials are available. Every agent's output stays human-gated regardless of deployment — listings always pause at `needs_review` until an operator approves them in the dashboard.

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

---

## License

[MIT](./LICENSE) © Ben Bracamonte
