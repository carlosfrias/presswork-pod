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
- **Design:** raster → SVG vectorization for optimal print scaling. Two paths, mirroring the bg-removal pattern (see `PLAN_birefnet_bg_removal.md`): **(A, default)** local Python image lib; **(B, opt-in)** external API like vectorize.ai. Include a path-simplification pass and whatever SVG finishing is needed for clean scaling + print output
- **Listing:** take down (deactivate) an Etsy listing from the dashboard listing-detail page
- **Ledger:** ...

## Infra / ops

- Move agents off local CLI onto Railway crons (hosting is "TBD" in CLAUDE.md)
- Volume target: define listings/week (CLAUDE.md open question)

## Ideas / unsorted

- ...
