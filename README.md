# Presswork POD

Autonomous print-on-demand pipeline for Etsy revenue generation.

## What This Is

A 4-agent system (Scout → Design → Listing → Ledger) that runs 24/7 on fleet infrastructure, generating POD listings on Etsy with minimal human oversight. Forks the open-source [Presswork](https://github.com/brac/presswork) project and deploys via Dokploy.

## Key Documents

- **[AGENTS.md](AGENTS.md)** — Single source of truth (Identity, Boundaries, Current State, Rules)
- **[AGENTS-DEEP.md](AGENTS-DEEP.md)** — Deep context loaded on demand (Architecture, ADs, ACs, Verification Suite)
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System overview, data flow, design decisions

## Quick Start

1. Fork github.com/brac/presswork → github.com/carlosfrias/presswork-pod
2. Create Etsy seller account ($15 setup fee)
3. Create Printify account (free) and link to Etsy
4. Provision fal.ai API key ($20 credits)
5. Deploy Supabase on fnet3 (32GB RAM)
6. Deploy agents + dashboard + Windmill on fnet1 via Dokploy
7. Run local end-to-end test with mock APIs
8. Configure Windmill schedules for all 5 agent flows

## Revenue Target

- $500/mo by day 60
- $2K/mo by day 90

## Autonomous Cash Score: 7.7

Build Now tier — agent can execute the full revenue cycle autonomously after initial setup.