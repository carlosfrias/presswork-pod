---
name: presswork-pod
intensity: On
domain: business
rank: 3
version: 2
last_rebuilt: 2026-09-11
status: active
repo: false
submodule: false
---

# Presswork POD

> **Purpose:** Deploy an autonomous print-on-demand pipeline on Etsy that generates revenue 24/7 without human intervention. Fork the open-source Presswork project, adapt it for our infrastructure, and turn it into a cash-producing agent system.

**What decision does this effort drive?** Whether the Presswork 4-agent POD pipeline can produce consistent autonomous revenue ($1-5K/mo) on Etsy with minimal human oversight.

**Success criteria:**
1. Presswork fork deployed to fleet infrastructure via Dokploy with all 4 agents running on schedule
2. First Etsy listing published (human-reviewed and approved)
3. 50+ listings live within 30 days
4. First sale recorded and margin tracked in Ledger
5. Revenue target: $500/mo by day 60, $2K/mo by day 90
6. System runs unattended for 7 consecutive days without manual intervention

## Boundaries & Constraints

### In Scope
- Fork and deploy Presswork POD pipeline · Configure Etsy shop and Printify account
- Deploy all 4 agents + dashboard + Windmill to fleet · NFS mount strategy for cross-node access
- Quality gates with hostile validation · Revenue tracking and margin monitoring
- Adapt pipeline for digital products (Etsy Factory) as phase 2

### Out of Scope
- Building from scratch (we're forking Presswork) · Manual POD operations · Marketing beyond Etsy SEO
- Custom image models (we use fal.ai's existing models) · Customer service (Etsy handles)

### Blast Zones
- `Efforts/Business/presswork-pod/` — this effort
- `fnet1:/opt/presswork-pod/` — deployed services on fleet node 1
- `fnet3:` — Supabase database
- `github.com/carlosfrias/presswork-pod` — forked repo
- `Etsy shop` · `Printify account` — listings/products published by the pipeline

### Constraints
- Human review gate ON for listings until quality validated (≥20 approved listings)
- Never auto-publish without passing all 6 compliance gates
- Price floor: $21.25 minimum (2.5× print cost)
- AI disclosure on every listing (Etsy requirement)
- No copying existing designs — style keywords only, no artist/product names in prompts
- Fleet nodes must maintain NFS mount for shared configuration
- API keys in Dokploy env vars, never in code
- All external API calls mocked in tests (no live keys in CI)

## Current State

**Phase:** 1 — Fork & Configure · **Updated:** 2026-09-11

| Priority | Task | Status | Agent |
|----------|------|--------|-------|
| P0 | Fork Presswork repo to github.com/carlosfrias/presswork-pod | 🔲 Not started | worker |
| P0 | Create Etsy shop account | 🔲 Not started | human |
| P0 | Create Printify account and link to Etsy | 🔲 Not started | human |
| P0 | Provision fal.ai API key | 🔲 Not started | human |
| P0 | Deploy Supabase on fnet3 | 🔲 Not started | fleet-operator |
| P0 | Configure NFS mounts on fleet nodes | 🔲 Not started | fleet-operator |
| P1 | Deploy Windmill on fnet1 via Dokploy | 🔲 Not started | fleet-operator |
| P1 | Configure environment variables in Dokploy | 🔲 Not started | worker |
| P1 | Run local end-to-end test with mock APIs | 🔲 Not started | worker |
| P2 | Deploy agents to fnet1 via Dokploy | 🔲 Not started | fleet-operator |

### Phase Plan

| Phase | Days | Focus | Gate |
|-------|------|-------|------|
| **1. Fork & Configure** | 1-7 | Fork Presswork repo, set up env vars, configure API keys, test locally | Local end-to-end test passes |
| **2. Fleet Deploy** | 8-14 | Deploy to fnet1 via Dokploy, Supabase on fnet3, NFS mounts, Windmill | All 4 agents run on schedule in production |
| **3. Validate** | 15-21 | Human review gate ON, 20+ listings, validate margin tracking | First sale recorded, margin tracking confirmed |
| **4. Scale** | 22-60 | Turn off review gate (if quality validated), increase niche breadth | 50+ listings live, $500/mo revenue |
| **5. Productize** | 61-90 | Adapt 4-agent architecture for digital products, add KDP pipeline | Second product line live |

### Open Decisions

| Decision | Status | Notes |
|----------|--------|-------|
| Etsy shop name | 🔲 Pending | Need to create or configure existing shop |
| Printify account | 🔲 Pending | Need to create or configure |
| fal.ai API key | 🔲 Pending | Need to provision |
| Supabase: self-hosted vs cloud | 🔲 Leaning self-hosted | fnet3 has 32GB RAM, plenty for Supabase |
| Windmill: deploy to fnet1? | 🔲 Pending | Need to deploy via Dokploy |
| Niche seed list | 🔲 Pending | Define initial 10-20 niches for Scout |

## Rules (Converged)

1. **Never copy existing designs.** FLUX prompts from style keywords only. No artist names, no product names, no IP.
2. **AI disclosure on every listing.** Verbatim `AI_DISCLOSURE_TEXT` in every description.
3. **Price floor:** `$price ≥ print_cost × 2.5`. Never list below $21.25.
4. **Human review gate ON** until 20 approved listings pass quality validation.
5. **All secrets via Dokploy env vars.** Never commit API keys.
6. **Idempotent writes.** Ledger uses UNIQUE constraints. Design uses SHA-256 dedup.
7. **Row-level locking.** `SELECT ... FOR UPDATE SKIP LOCKED` on all agent polls.
8. **Fleet tokens are scarce.** Use worker agents efficiently, prefer scout for recon.
9. **NFS mounts before Docker.** Ensure fleet nodes can reach shared filesystem before deploying containers.
10. **Test with mocks first.** All external APIs must be mockable. No live API keys in CI.

## Self-Improvement

**Improve this effort:** Say "apply AGENT-SPEC to presswork-pod" or "improve presswork-pod"
**Process:** IKA skill → FRP CORE → AGENT-SPEC Invocation Protocol (loaded on demand)
**Staleness:** Sections unchanged >30d (On), >90d (Ongoing), >365d (Simmering) need improvement

## Deep Context

Full architecture, agent specifications, infrastructure details, quality gates, acceptance criteria, and verification suite → [[AGENTS-DEEP]]

---

*Last updated: 2026-09-11 · v2 · Agent-spec applied. Lean AGENTS.md + AGENTS-DEEP.md split.*