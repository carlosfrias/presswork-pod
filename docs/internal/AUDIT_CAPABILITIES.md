# Presswork Capability Audit & Setup Checklist

**As of 2026-05-11 · branch `main`**

You asked: what does the system do, what's hiding behind flags, and what do I still need to set up. Below is the inventory plus an ordered Day-0 checklist. Verified against source — flags marked **shipped** are wired in code today; **planned** means the design doc exists but the runtime doesn't read the flag yet.

---

## TL;DR for your specific questions

| Your question | Answer |
|---|---|
| Need Etsy API? | Yes — app credentials + OAuth tokens + shop ID + shipping profile + **readiness state ID** (new, Sept 2025) + production-partner ID. |
| Declare Printify a production partner on Etsy? | **Yes, mandatory.** Etsy Shop Manager → Production Partners → register Printify → paste numeric ID into `ETSY_PRODUCTION_PARTNER_ID`. Listing validation hard-fails without it. |
| Do I need a "premium mockup service"? | **No, not required.** Default behavior is Printify's auto-generated mockups — they always populate `design_packages.mockup_urls` as a side effect of creating the hidden Printify product. No external sign-up. |
| Does it default to Printify? | **Yes.** If no other mockup renderer is configured, Printify mockups are what go on the Etsy listing. |
| Is there a PlaceIt integration? | **No.** Zero references to PlaceIt in code. The planned premium-mockup path is **Dynamic Mockups** (dynamicmockups.com), not PlaceIt — and it's not wired up yet (plan doc only). |
| What else could it do with the right flag? | Screen-print mode, Aura-SR 4× upscaler, bring-your-own-image smoke, human-review bypass, Slack alerts, Resend email alerts, Etsy/Printify webhooks vs poller fallback. Details below. |

---

## Section 1 — Capability inventory (what already works)

### 1.1 Design modes (`packages/design/`)

| Capability | Default | How to trigger | Status |
|---|---|---|---|
| **Full-color FLUX Pro 1.1** | On | default for any brief | Shipped |
| **Screen-print mode** — single-ink, whitespace stripped, shirt color shows through | Off (per-brief) | Scout's Claude analyzer sets `trend_briefs.print_style = "screen_print"` based on niche keywords (vinyl, monochrome, bold silhouette) | Shipped — migration `014` + `packages/design/prompt_builder.py` + `image_processor.py` |
| **Subject-centric routing** — forces centered isolated subject for occupations/identities | Auto | Detected from brief keywords (nurse, teacher, mom, fishing, …) | Shipped — `packages/design/prompt_builder.py:49-184` |
| **Aura-SR 4× upscaler** — FLUX 1024² → ~4096² via fal-ai/aura-sr, soft-fails to LANCZOS | **On** | `UPSCALER_ENABLED=true` (default true in `shared_py/config.py:56`) | Shipped — `packages/design/upscaler.py` |
| **Prompt dedup** — SHA-256 hash skips redundant fal.ai calls | On | automatic via migration `006_design_prompt_hash` | Shipped |

### 1.2 Mockups (`packages/listing/src/printify.ts`)

| Capability | Default | How to trigger | Status |
|---|---|---|---|
| **Printify auto-mockups** — 2–6 stock mockups returned when hidden product is created | Always on | automatic side effect of `createHiddenProduct()` | Shipped |
| **Mockup provenance flag** — `mockups_from_actual_design=true` written in same tx as `mockup_urls` (compliance rule 4) | Always on | automatic | Shipped — `compliance.ts` `validateMockupProvenance` |
| **Dynamic Mockups custom renderer** — composites design onto custom templates (lifestyle, close-up) | **Planned** | `MOCKUP_RENDERER_ENABLED=true` + `DYNAMIC_MOCKUPS_API_KEY=…` (env keys exist in the plan doc only — `shared/src/config.ts` does not parse them yet) | **Planned** — `PLAN_MOCKUP_RENDERER.md`, no `mockup-renderer.ts` exists |
| **PlaceIt** | n/a | n/a | **Not integrated. Do not set up an account.** |

### 1.3 Image-sourcing alternatives

| Capability | Use | Status |
|---|---|---|
| **Bring-your-own-image smoke** — `scripts/inject_image_smoke.py` bypasses Design entirely. Flags: `--mode {full_color,screen_print}` and `--shirt-color {white,black}` | Manual smoke / dev tool, not production | Shipped |
| **Synthetic design smoke** — `scripts/smoke_design_to_printify.py` runs Design end-to-end without Scout or DB | Manual smoke | Shipped |
| **Listing → Printify smoke** — `scripts/smoke_listing_printify.ts` validates real Printify upload against a real `design_packages` row | Manual smoke | Shipped |

### 1.4 Human review gate

| Capability | Default | How to flip | Status |
|---|---|---|---|
| **Manual approval queue** — listings stop at `needs_review`; approve via `scripts/approve-listing.ts <listing_id>` | **Enabled** | `HUMAN_REVIEW_ENABLED=true` (default). Set `false` to auto-publish straight to Etsy. | Shipped — `publisher.ts:50` reads it |

### 1.5 Order pipeline (Etsy → Printify → tracking)

| Capability | Default | Config | Status |
|---|---|---|---|
| **Etsy order webhook** `POST /webhook/etsy-order` (HMAC-SHA256 with `ETSY_API_SECRET`) | On | `ETSY_WEBHOOK_SECRET` for Svix-style verification | Shipped — `server.ts:50` |
| **Printify webhook** `POST /webhook/printify-order` — `order:updated`, `order:shipment:created`, base64 HMAC | Optional | `PRINTIFY_WEBHOOK_BASE_URL` + `PRINTIFY_WEBHOOK_SECRET`; auto-registers on boot via `registerPrintifyWebhooks()` | Shipped — `printify-webhook.ts` |
| **Receipt poller (safety net)** — polls Etsy `/receipts?was_paid=true&was_shipped=false` | On | runs as cron entry `poll-receipts-entry.ts` | Shipped |
| **Tracking poller (safety net)** — polls Printify for shipment status, PATCHes tracking back to Etsy | On | runs as cron entry `poll-tracking-entry.ts` | Shipped |

### 1.6 Pricing & economics (`packages/fulfillment/src/economics.ts`)

- Hard **2.5× print-cost pricing floor**, factoring Etsy fees ($0.20 + 6.5% + 3% + $0.25).
- **Multi-currency** support (migration `010`): non-USD buyer amounts normalized via static `USD_RATES` table.
- **Blueprint cost lookup**: `BLUEPRINT_PRINT_COST_USD` — currently Gildan 64000 ($8.50). Adding a new blueprint requires adding an entry here (unknown blueprint throws).

### 1.7 Alerts

| Channel | Default | Config | Status |
|---|---|---|---|
| **Slack** webhook (severities `info/warn/error`) | Optional | `SLACK_WEBHOOK_URL` | Shipped (TS + Python) |
| **Resend email** — TS notifier hits `api.resend.com/emails` | Optional | `RESEND_API_KEY` + `ALERT_EMAIL` | Shipped on TS side (`shared/src/notifier.ts:51`). Python side accepts the env keys but does not yet send (only Slack from Python agents). |

### 1.8 Compliance gates (`packages/listing/src/compliance.ts`)

Five code-enforced validators (CLAUDE.md lists 6 "rules" but rule 5 — single-shop — is operational, not coded):

1. `validateProductionPartnerId()` — `ETSY_PRODUCTION_PARTNER_ID` set + positive.
2. `validateAiDisclosure()` — exact `AI_DISCLOSURE_TEXT` constant present verbatim.
3. `validateNoForbiddenTerms()` — no "handmade", "OOAK", "limited edition", etc. (scrubs AI disclosure first).
4. `validateMockupProvenance()` — `mockups_from_actual_design=true`.
5. `validateNoOffPlatform()` — no URLs, `@handles`, "DM me" / "visit our site".

Validators run **twice**: pre-Claude (early reject) + inside `executeEtsyPublish` (defense-in-depth).

### 1.9 Multi-provider routing (future-ready)

- `design_packages.printify_print_provider_id` is non-null (migration `015`). Only **Printify** is wired today; Printful was on the open-questions list but never implemented.

### 1.10 Evals / observability

- **Copywriter behavioral evals** — `packages/listing/evals/copywriter/` runs Vitest snapshots over copywriter output. Set `EVAL_LIVE=1` to hit Anthropic for drift detection.
- **`/healthz/printify`** — error-rate ring buffer (last 200 requests); returns `ok=false` at ≥4% combined 4xx/5xx (Step 5 of `PLAN_PRINTIFY_API_COMPLIANCE.md`).
- **Dashboard (Spindl)** — design only, `PRESSWORK_DASHBOARD_PLAN.md`. Not built.
- **`AGENT_OVERVIEW.html`** — static reference page checked into repo.

---

## Section 2 — Day-0 setup checklist (ordered)

Roughly 6–8 hours wall-clock if no surprises. Phases 1–3 can run in parallel; 4 onward is sequential.

### Phase 1 — Anthropic
1. **Anthropic API key** → `ANTHROPIC_API_KEY`. https://console.anthropic.com/account/keys

### Phase 2 — Etsy (longest path; do this first)
2. **Etsy developer app** → `ETSY_API_KEY`, `ETSY_API_SECRET`. https://www.etsy.com/developers/register · scopes: `listings_r`, `listings_w`, `transactions_r`, `shops_r`.
3. **OAuth tokens** → `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`. Run `python scripts/get_etsy_tokens.py`. Access token rotates every 60 min — the agent auto-refreshes from the refresh token stored in Supabase `config`. (See `AUDIT_3.md` finding #11 — refresh-token rotation bug noted.)
4. **Shop ID & shipping profile** → `ETSY_SHOP_ID`, `ETSY_SHIPPING_PROFILE_ID`. Etsy Shop Manager → Settings → Shop Basics + Shipping & Policies.
5. **Readiness state ID** → `ETSY_READINESS_STATE_ID`. New as of Sept 30 2025. Run `npx ts-node scripts/get_etsy_readiness_state.ts` — lists existing definitions or creates one with default 1–3 business-day processing time. Required on every physical listing.
6. **Register Printify as production partner** → `ETSY_PRODUCTION_PARTNER_ID`. Etsy Shop Manager → Settings → Production Partners → "Add a Production Partner" → describe Printify (location: US, type: print-on-demand drop-shipper, "I do not own this business"). Etsy assigns a numeric ID — paste it. **Listing validation hard-fails without this.**
7. **Etsy webhook subscription (production only)** → `ETSY_WEBHOOK_SECRET` (`whsec_<base64>`). Register against your Railway URL once deployed.

### Phase 3 — fal.ai
8. **fal.ai API key** → `FAL_KEY`. https://fal.ai/dashboard/keys · billed pay-as-you-go (~$0.05/image FLUX + ~$0.01/image Aura-SR).

### Phase 4 — Printify
9. **Printify shop linked to Etsy** → Printify dashboard → Connect Etsy. Without this, fulfillment posts orders that are never produced.
10. **Printify API token + shop ID** → `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`. Printify → Account → API & Webhooks.
11. **Printify webhook secret (optional)** → `PRINTIFY_WEBHOOK_BASE_URL` + `PRINTIFY_WEBHOOK_SECRET` (`openssl rand -hex 32`). Fulfillment auto-registers webhooks on boot. Without these, polling fallback still works.

### Phase 5 — Supabase
12. **Project + service-role key** → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. https://app.supabase.com → New Project. Service-role only — anon key is never used.
13. **Run migrations** → `supabase db push` (or paste each file from `infra/supabase/migrations/` into SQL Editor). 15 migrations, idempotent.
14. **Storage buckets** — `designs` and `mockups` (public read, service-role write). Hardcoded names — do not rename.

### Phase 6 — Alerts (optional)
15. **Slack webhook** → `SLACK_WEBHOOK_URL`. https://api.slack.com/apps · Incoming Webhooks. Strongly recommended — error path soft-fails to it.
16. **Resend** → `RESEND_API_KEY`, `ALERT_EMAIL`. https://resend.com/api-keys. Optional duplicate of Slack.

### Phase 7 — Local + Railway
17. `npm install` · `python3.12 -m venv .venv && source .venv/bin/activate` · `pip install -r packages/scout/requirements-dev.txt && pip install -r packages/design/requirements-dev.txt`.
18. Copy `.env.example` → `.env`, fill in every var from Phases 1–6.
19. **Railway project** → connect GitHub, create shared env-var group, deploy four services per `infra/railway.toml`: `fulfillment` (web, always-on), `scout` (cron `0 2 * * *`), `design` (cron `*/15 * * * *`), `listing` (cron `*/15 * * * *`).
20. Once Railway public URL exists, register both webhook URLs (Etsy + Printify) against it.

### Phase 8 — Smoke
21. **Scout** → `python -m packages.scout.main`. Expect 3–5 rows in `trend_briefs` with `status='pending'`.
22. **Design** → `python -m packages.design.main`. Expect a row in `design_packages` with `status='done'` and a Supabase Storage URL.
23. **Listing** → `npx tsx packages/listing/src/index.ts`. With `HUMAN_REVIEW_ENABLED=true`, expect `status='needs_review'`. Approve: `npx tsx scripts/approve-listing.ts <listing_id>`. Re-run listing — expect `active`.
24. **Fulfillment** → buy your own listing (or fire a test webhook). Expect an `orders` row going `received` → `submitted` → `shipped`, with `margin_usd` populated.

---

## Section 3 — What you don't need

| Thing | Why you can ignore it |
|---|---|
| **PlaceIt account** | No code references it. Not integrated. |
| **Premium mockup service** | Printify mockups are wired by default. Dynamic Mockups is the planned upgrade path but currently dark (no code). |
| **Printful or any second print provider** | Schema is provider-aware but only Printify is wired. |
| **Admin web UI** | Spindl dashboard is a design doc only. Use Supabase Studio + `scripts/approve-listing.ts`. |
| **Niche config table** | Niches are hardcoded in `packages/scout/seeds.py` for now. Editing the seed list ships via redeploy. |

---

## Section 4 — Capability flag quick reference

| Env var | Default | Effect when off | Effect when on |
|---|---|---|---|
| `HUMAN_REVIEW_ENABLED` | `true` | Listings auto-publish to Etsy after compliance gates pass | Listings stop at `needs_review` for manual approval via CLI |
| `UPSCALER_ENABLED` | `true` | Designs ship at FLUX-native 1024² (then LANCZOS-padded) | Aura-SR 4× upscale before bg removal (~$0.01 extra/design) |
| `MOCKUP_RENDERER_ENABLED` | **not yet read** | n/a — feature dark | Planned: prepend custom Dynamic Mockups to Printify mockups |
| `SLACK_WEBHOOK_URL` | unset | Alerts go to stderr only | Slack messages on warn/error |
| `RESEND_API_KEY` + `ALERT_EMAIL` | unset | No email alerts | TS notifier sends transactional email on errors |
| `PRINTIFY_WEBHOOK_BASE_URL` + `PRINTIFY_WEBHOOK_SECRET` | unset | Tracking-poller fallback every 5 min | Real-time Printify shipment events |
| `EVAL_LIVE` | unset | Copywriter evals run replay-only | Hits Anthropic; captures snapshots |

---

## Section 5 — Gotchas worth burning into memory

1. **`ETSY_PRODUCTION_PARTNER_ID` must be numeric and positive.** Zod throws a cryptic validator error if it's missing or zero.
2. **`ETSY_READINESS_STATE_ID` is new (Sept 2025).** If Etsy publishes start failing with "readiness_state_id required", you didn't run script 5.
3. **Etsy access tokens expire every 60 min.** Refresh tokens rotate on each refresh — make sure the rotated refresh token is captured and persisted, or the next refresh will fail with `invalid_grant`.
4. **Etsy uses "receipts", not "orders".** The poller hits `/receipts`.
5. **PlaceIt is NOT integrated.** Don't sign up.
6. **Compliance validators run twice.** If you only patch the pre-Claude one and not the publish-time one, the publish will still reject — and vice versa. Keep them and the copywriter prompt in sync (CLAUDE.md is explicit about this).
7. **`mockups_from_actual_design` and `mockup_urls` must be written in the same tx.** Splitting them creates a resume path where the boolean is true but the URLs are stale.
8. **Bring-your-own-image is smoke-only.** It writes to `.tmp/smoke/`, no DB rows — useful for validating Printify wiring without burning a fal.ai credit.

---

**Cross-references:**
- `CLAUDE.md` — agent specs, schemas, business rules
- `PLAN_MOCKUP_RENDERER.md` — Dynamic Mockups design
- `PLAN_PRINTIFY_API_COMPLIANCE.md` — rate limits, idempotency, healthz contract
- `PLAN_ETSY_BUG_FIXES.md` — webhook + processing-profile migration history
- `PRESSWORK_DASHBOARD_PLAN.md` — Spindl design
