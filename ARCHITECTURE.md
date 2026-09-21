# Presswork POD — Architecture

## Overview

Presswork POD is an autonomous print-on-demand pipeline that generates revenue on Etsy 24/7. It forks the open-source Presswork project (github.com/brac/presswork) and deploys it on fleet infrastructure via Dokploy.

The system has 4 agents orchestrated by Windmill, backed by Supabase, and surfaced through a Next.js dashboard:

1. **Scout** (Python) — nightly trend research via Etsy API
2. **Design** (Python) — AI image generation via fal.ai
3. **Listing** (TypeScript) — SEO copy and Etsy publishing via Printify
4. **Ledger** (TypeScript) — order tracking and margin monitoring

## Architecture Diagram

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

## Data Flow

1. **Scout** runs nightly at 02:00 UTC, scans Etsy trending listings, generates trend briefs → `trend_briefs` table
2. **Design** runs every 15 min, picks up approved briefs, generates FLUX prompts → fal.ai → 300dpi PNG → `design_packages` table
3. **Listing** runs every 15 min, picks up approved designs, creates Printify products → Etsy listings → `listings` table
4. **Ledger** runs every 30 min for receipts and daily at 13:00 UTC for digests, tracks orders and margins → `orders` table + Slack/Email alerts

## Deployment

All services deploy to **fnet1** (Dokploy) except Supabase on **fnet3**. NFS mounts provide shared filesystem access. See AGENTS-DEEP.md for Docker Compose configuration and environment variables.

## Quality Gates

Hostile validation with 3 automated attempts before human escalation:
- **G1: Trend Quality** — niche dedup, price floor, color palette, no IP
- **G2: Design Quality** — resolution, dedup, size, watermark, transparency
- **G3: Listing Compliance** — 6 hard gates (AI disclosure, no IP, price floor, production partner, mockup provenance, no off-platform)
- **G4: Margin Health** — margin ≥ 25%, revenue trend stable
- **G5: API Health** — rate limits, auth, error rates

## Design Decisions

| Decision | Choice | Alternative Rejected |
|----------|--------|---------------------|
| Starting point | Fork Presswork (proven, 60 migrations) | Build from scratch |
| Deployment | Dokploy on fnet1 (our infra) | Railway (recurring cost) |
| Database | Self-hosted Supabase on fnet3 | Supabase Cloud (cost, sovereignty) |
| Orchestration | Windmill (visual, retry, observability) | Cron (no observability) |
| Shared config | NFS mount (already exported) | S3 (cost, complexity) |
| Quality validation | Hostile (3 auto-attempts before human) | Human at every gate (doesn't scale) |

See AGENTS-DEEP.md for Architecture Decisions (AD-1 through AD-6) with full rationale.