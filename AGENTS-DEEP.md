---
name: presswork-pod
tier: deep
version: 1
last_rebuilt: 2026-09-11
---

# Presswork POD — Deep Context

> Loaded on demand. Lean AGENTS.md contains Identity, Boundaries, Current State, Rules, and Self-Improvement.

## Architecture

### System Overview

```
                    ┌─────────────┐
                    │   Windmill   │ ← Scheduling, orchestration, monitoring
                    │  (fnet1)     │
                    └──────┬──────┘
                           │ triggers
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Scout   │ │  Design  │ │  Listing  │
        │ (Python) │ │ (Python) │ │   (TS)    │
        │  Nightly │ │  15 min  │ │  15 min   │
        └────┬─────┘ └────┬─────┘ └────┬──────┘
             │             │             │
             ▼             ▼             ▼
        ┌──────────────────────────────────────┐
        │          Supabase (fnet3)           │
        │  trend_briefs → design_packages →    │
        │  listings → orders                  │
        └──────────────┬───────────────────────┘
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
        ┌────────┐ ┌────────┐ ┌────────┐
        │ fal.ai │ │  Etsy  │ │Printify│
        │ Images │ │  API   │ │  API   │
        └────────┘ └────────┘ └────────┘
              │        │        │
              │        ▼        │
              │   ┌─────────┐  │
              │   │ Dashboard│  │
              │   │ (Next.js)│  │
              │   └─────────┘  │
              │                 │
        ┌─────┴─────────────────┴──────┐
        │     Ledger (TypeScript)      │
        │     Receipts → Orders →      │
        │     Margin → Slack/Email     │
        └──────────────────────────────┘
```

### Agent Specifications

#### Agent 1: Scout (Python)
- **Schedule:** Nightly at 02:00 UTC (Windmill cron)
- **Input:** Etsy trending listings (via Etsy API)
- **Process:** Scan niches → extract structured briefs via Claude → dedup against last 7 days
- **Output:** `trend_briefs` rows in Supabase (status: `needs_review`)
- **AI:** Claude Sonnet 4 for trend analysis
- **Rate limit:** 5 req/sec async semaphore

#### Agent 2: Design (Python)
- **Schedule:** Every 15 minutes (Windmill cron)
- **Input:** Approved trend briefs from Supabase
- **Process:** Claude generates FLUX-safe image prompt → fal.ai generates 300dpi PNG → upload to Supabase Storage
- **Output:** `design_packages` rows (status: `needs_review`)
- **AI:** Claude Sonnet 4 for prompts, fal.ai (FLUX Pro 1.1 / GPT Image 2) for generation
- **Dedup:** SHA-256 hash on prompts to avoid duplicate generation costs

#### Agent 3: Listing (TypeScript)
- **Schedule:** Every 15 minutes (Windmill cron)
- **Input:** Approved design packages from Supabase
- **Process:** Create hidden Printify product → generate mockups → Claude writes SEO copy → publish to Etsy
- **Output:** `listings` rows (status: `active` on Etsy)
- **AI:** Claude Opus 4.8 for listing copy (latest flagship, no model selection)
- **Compliance:** 6 hard gates enforced in code (AI disclosure, no IP names, pricing floor, production partner, mockup provenance, no off-platform)
- **Human review gate:** Listings pause at `needs_review` until dashboard approval

#### Agent 4: Ledger (TypeScript)
- **Schedule:** Every 30 minutes for receipts, daily at 13:00 UTC for digest (Windmill cron)
- **Input:** Etsy receipts API
- **Process:** Log orders with sale price, fees, print cost, margin, buyer country
- **Output:** `orders` rows, Slack alerts (low margin), daily email digest
- **Idempotent:** UNIQUE constraint on `etsy_order_id` prevents double-counting

### Infrastructure

| Component | Host | Notes |
|-----------|------|-------|
| Supabase (Postgres + Storage) | fnet3 (32GB RAM) | Primary database, 60 migrations |
| Scout + Design agents | fnet1 (Dokploy) | Python 3.12 containers |
| Listing + Ledger agents | fnet1 (Dokploy) | Node 20 containers |
| Dashboard (Next.js) | fnet1 (Dokploy) | Review and approval UI |
| Windmill | fnet1 (Dokploy) | Scheduling and orchestration |
| NFS mount | fnet1 + fnet3 | `/Users/friasc/Cloud/carlos-desktop` for shared filesystem |
| GitHub repo | github.com/carlosfrias/presswork-pod | Fork of brac/presswork |

### NFS Strategy

macOS NFS server exports `/Users/friasc/Cloud/carlos-desktop` to the LAN (192.168.0.0/24) and Tailscale (100.64.0.0/10). Fleet nodes mount for shared configuration, design assets, agent state, and dashboard local development.

### Windmill Orchestration

| Schedule | Agent | Windmill Flow |
|----------|-------|---------------|
| 02:00 UTC daily | Scout | `presswork-scout` flow |
| Every 15 min | Design | `presswork-design` flow |
| Every 15 min | Listing | `presswork-listing` flow |
| Every 30 min | Ledger (receipts) | `presswork-ledger-receipts` flow |
| 13:00 UTC daily | Ledger (digest) | `presswork-ledger-digest` flow |

### Quality Gates (Hostile Validation)

Each gate uses **hostile validation** — 3 automated attempts before human escalation:

| Gate | Validation | Escalation |
|------|-----------|------------|
| **G1: Trend Quality** | Niche not in last 7 days, price > 2.5× print cost, ≥3 colors, no IP/artist names | Slack alert + dashboard flag |
| **G2: Design Quality** | 300dpi PNG, SHA-256 not duplicate, 500KB-5MB, no watermark, background transparency | Slack alert + dashboard flag |
| **G3: Listing Compliance** | 6 hard gates: AI disclosure, no forbidden terms, no off-platform URLs, production partner, mockup provenance, price ≥ 2.5× print cost | Listing blocked, human must approve |
| **G4: Margin Health** | Margin ≥ 25% per order, revenue trend stable, no sudden fee spikes | Slack alert, daily margin digest |
| **G5: API Health** | Rate limits not exceeded (Etsy 10/sec, Printify 600/min), no auth expiry, no 5xx >5% | Auto-retry 3× with exponential backoff, then Slack alert |

## Architecture Decisions

### AD-1: Fork Presswork, Don't Build From Scratch
**Chosen:** Fork github.com/brac/presswork
**Why:** Proven architecture with 60 migrations, full test suite, Etsy compliance gates, and production dashboard. Building from scratch would take months; forking takes days.
**Alternatives:** Build custom pipeline (rejected: too much work, no test coverage), DigiVendAgent (rejected: less mature, no POD focus)

### AD-2: Dokploy Deployment, Not Railway
**Chosen:** Deploy on fnet1 via Dokploy
**Why:** Infrastructure under our control, no recurring SaaS cost, NFS mount access, existing fleet management.
**Alternatives:** Railway (rejected: recurring cost, no NFS access, external dependency)

### AD-3: Self-Hosted Supabase on fnet3
**Chosen:** Self-host Supabase on fnet3 (32GB RAM)
**Why:** Full control, no Supabase Cloud costs, NFS access for backups, fleet proximity for low latency.
**Alternatives:** Supabase Cloud (rejected: recurring cost, data sovereignty), SQLite (rejected: Presswork requires Postgres features like FOR UPDATE SKIP LOCKED)

### AD-4: Windmill for Orchestration
**Chosen:** Windmill for scheduling and monitoring
**Why:** Visual workflow editor, retry logic, error handling, observability. Replaces manual cron with managed scheduling.
**Alternatives:** Cron on each container (rejected: no observability, no retry, no dashboard), GitHub Actions (rejected: not suitable for long-running agents)

### AD-5: NFS for Shared Configuration
**Chosen:** Mount `/Users/friasc/Cloud/carlos-desktop` on fleet nodes via NFS
**Why:** Already exported, fleet nodes have SSH access, allows local filesystem access without copying files.
**Alternatives:** Git-based config (rejected: slow for large assets), S3 (rejected: additional cost and complexity)

### AD-6: Hostile Validation at Quality Gates
**Chosen:** 3 automated validation attempts before human escalation
**Why:** Reduces human overhead while maintaining quality. System tries to self-correct before asking for help.
**Alternatives:** Human review at every gate (rejected: doesn't scale), no review (rejected: too risky for Etsy compliance)

## Toolchain

### Required Tools
- `git` — fork and manage presswork-pod repo
- `docker` / `docker-compose` — containerization
- `node` (v20+) — Listing and Ledger agents
- `python3.12` — Scout and Design agents
- `supabase` CLI — database migrations and local testing
- `npm` — dependency management

### Fleet Agents
- **fleet-operator** — deploy services to fnet1/fnet3 via Dokploy
- **fleet-semaphore** — manage Dokploy templates and schedules
- **worker** — code modifications, testing, configuration
- **scout** — codebase recon for understanding Presswork internals
- **reviewer** — code quality review before commits

### Forbidden Tools
- Direct production API calls without mock testing
- Auto-publishing without human review (until Phase 4)
- Committing API keys or secrets to git

## Acceptance Criteria

| AC | Criterion | Verify By |
|----|-----------|-----------|
| AC-1 | Fork exists at github.com/carlosfrias/presswork-pod | `git clone` succeeds |
| AC-2 | All 4 agents run locally with mock APIs | `INTEGRATION=1 npm run test:e2e` passes |
| AC-3 | Supabase deployed on fnet3 with all 60 migrations | `supabase db reset` succeeds on fnet3 |
| AC-4 | All 4 agents + dashboard deployed on fnet1 via Dokploy | `docker ps` shows all containers running |
| AC-5 | NFS mounts accessible from fnet1 and fnet3 | `ls /mnt/carlos-desktop/` works on both nodes |
| AC-6 | Windmill flows configured for all 5 schedules | Windmill UI shows all flows |
| AC-7 | First Etsy listing published (human-reviewed) | Listing visible on Etsy shop |
| AC-8 | Quality gates pass (all 5) | Hostile validation attempts logged |
| AC-9 | Ledger records first sale with margin | `orders` table has row with positive `margin_usd` |
| AC-10 | System runs unattended for 7 days | No manual intervention needed for 7 consecutive days |

## Verification Suite

1. **Local end-to-end test:** Scout → Design → Listing pipeline runs with mock APIs
2. **Fleet deployment test:** All containers healthy on fnet1, Supabase accessible on fnet3
3. **NFS mount test:** Both fleet nodes can read/write shared filesystem
4. **Quality gate test:** Each gate correctly blocks non-compliant output
5. **Compliance test:** All 6 Etsy seller policy gates enforced in code
6. **Margin test:** Ledger correctly computes margin at various price points
7. **Rate limit test:** Etsy and Printify rate limits respected under load
8. **Error recovery test:** Agent recovers from transient failures (retry 3 times, then alert)

## Durable Knowledge Extracted

- Presswork (github.com/brac/presswork) has 60 migrations, full test suite, Etsy compliance gates, and a production Next.js dashboard — proven architecture worth forking
- Etsy API rate limit: 10 requests/sec; Printify: 600 requests/min
- fal.ai FLUX Pro 1.1 costs $0.04/image; GPT Image 2 available as alternative
- Etsy requires AI disclosure on all AI-generated listings
- Printify pricing: t-shirts $8.95, mugs $5.50, posters $3-8
- Etsy costs: $15 setup fee, $0.20/listing, 6.5% transaction fee, 3%+$0.25 payment processing
- Total startup cost: ~$35 (Etsy setup + first listings + fal.ai credits)
- Human review gate should stay ON until 20+ listings validated, then can be toggled OFF
- The 4-agent pipeline (Scout→Design→Listing→Ledger) mirrors the autonomous cash production pattern from ACS evaluation

---

*Deep context for presswork-pod. Lean AGENTS.md contains Identity, Boundaries, Current State, Rules, and Self-Improvement.*