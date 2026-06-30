# Backlog — Future Features & Ideas

Unscoped ideas. When one is picked up, it graduates to its own `PLAN_*.md`
and gets removed (or struck through) here. Keep entries short — a line that
captures the intent, not a spec. The spec is the plan doc's job.

---

## Product / catalog

- Multi-product support (mugs, posters, mousepads, tote bags beyond tees) — **scoped:** see `PLAN_multi_product_types.md`
- Color/size variants per product — **in progress:** see `PLAN_shirt_color_size_variants.md`
- Add Printful as a secondary provider for redundancy (CLAUDE.md open question)
- Decide launch blueprint set: tees only, or +mugs/posters? (CLAUDE.md open question)

## Agents

- **Scout:** niche seed list — define starting categories (CLAUDE.md open question)
- **Scout:** link a brief back to the source Etsy listings that led to its creation (provenance/traceability)
- **Scout:** best-seller feedback loop — feed top-performing niches (from `orders` margin data) back into seed selection so Scout learns from what actually sold
- **Design:** raster → SVG vectorization for optimal print scaling. Two paths, mirroring the bg-removal pattern (see `PLAN_birefnet_bg_removal.md`): **(A, default)** local Python image lib; **(B, opt-in)** external API like vectorize.ai. Include a path-simplification pass and whatever SVG finishing is needed for clean scaling + print output
- **Listing:** take down (deactivate) an Etsy listing from the dashboard listing-detail page
- **Ledger:** ...

## Infra / ops

- Move agents off local CLI onto Railway crons (hosting is "TBD" in CLAUDE.md)
- Volume target: define listings/week (CLAUDE.md open question)
- ~~Stuck-row watchdog — flag rows sitting in a non-terminal status too long (`pending_publish` never picked up, `processing` orphaned by a crashed run, aging `needs_review`). One query per table + the existing Slack notifier. Catches silent pipeline stalls~~ — **done:** `packages/ledger/src/watchdog.ts` (manual one-shot, `npm run watchdog --workspace=packages/ledger`)

## Dashboard / UX

- Pipeline-health panel on the home page — rows-per-status per table + oldest-row age, so "is anything stuck?" is a glance instead of a query
- LLM spend view — surface the cost data already tracked in `shared/src/llm-usage.ts` / `shared_py/llm_usage.py` as a per-agent / per-day rollup
- ~~Error-row triage view — all `error` rows across tables in one place with one-click requeue (esp. Design, which has no auto-retry per CLAUDE.md)~~ — **done:** `/errors` page (`packages/dashboard/app/errors/`, reuses existing retry actions)

## Testing / quality

- ~~Compliance golden-fixture tests — snapshot tests asserting each of the 6 seller-policy rules against fixture listings, so edits to the coupled copywriter-prompt + validators pair can't silently let policy-violating listings through~~ — **done:** `packages/shared/src/compliance-golden.test.ts` + `__fixtures__/listing-compliance-fixtures.ts`

## Ideas / unsorted

- ...
