# Plan — Multi-Product Support (mugs, posters, mousepads, etc. beyond t-shirts)

**Status:** Proposed — awaiting approval before any code changes. Plan approval ≠ execution approval.
**Date:** 2026-05-30
**Author:** Claude (scoped via parallel codebase read)

---

## 1. Goal (owner)

Let the Design pipeline put a print on Printify product types **other than the Gildan 64000 t-shirt** — mugs, posters, mousepads, tote bags, whatever Printify offers — and carry that product type cleanly through Listing → Etsy → Ledger.

---

## 2. The headline finding

**This is a medium lift, not a rewrite.** Whoever built the blueprint layer already anticipated multi-product: the entire publish + economics tier routes on `printify_blueprint_id` through `Record<blueprint_id, …>` maps. Adding a product type is mostly **adding rows to existing maps** plus **one real architectural decision** (where product type comes from) plus **threading the target product into image generation** (a mug wraparound is not a t-shirt resize).

Effort, concretely:
- **First new product type: ~1–2 days.**
- **Each subsequent type: ~1–2 hours** (fill in the maps, register a taxonomy + mockup template).

---

## 3. The one decision that gates everything

A design must know its target product **before it generates the image** — a 11oz mug is a ~2700×1050 wraparound, a poster is a different aspect ratio entirely, a t-shirt is the 4500×5400 chest canvas. This is not a downstream resize. So we must decide **where "make this a mug vs a shirt" is set.**

Three options (pick one before execution):

| Option | How it works | Trade-off |
|---|---|---|
| **A — Per-brief field (recommended)** | Add `product_type` (or `printify_blueprint_id`) to `trend_briefs`. Scout/Builder sets it; default = `tshirt`. | Most flexible, fits the existing human gate — the Builder already authors `image_description`, so they're the natural place to pick the surface. One migration. |
| **B — Per-niche config** | Niche seeds in the `config` table map to a product type (e.g. "kitchen humor" → mug). | Simpler, no per-design control. Coarse — every design in a niche is the same product. |
| **C — Per-brief blueprint ID, no abstraction** | Brief carries raw `printify_blueprint_id`; skip the friendly product-type name. | Least code, but leaks Printify IDs into Scout/Builder and the dashboard. |

**Recommendation: Option A.** It matches the existing "every output is human-gated" pattern and keeps the friendly product-type name (`tshirt`/`mug`/`poster`) as the routing key, with blueprint/provider/variant IDs resolved from a registry. The rest of this plan assumes A.

---

## 4. What's already generic (verified — no work needed)

These already key on `blueprint_id`. Adding a product = adding a row:

| Concern | Location | Note |
|---|---|---|
| Print cost / shipping cost | `packages/ledger/src/constants.ts` (`BLUEPRINT_PRINT_COST_USD`, `BLUEPRINT_SHIPPING_COST_USD`) | Generic lookup; throws `UnknownBlueprintError` if a blueprint is unmapped — fails loud, good. |
| Etsy inventory / variant mapping | `packages/shared/src/etsy-inventory.ts` + `etsy-blueprints.ts` (`BLUEPRINT_VARIATION_AXES`) | Reads variation axes per blueprint. A mug's `["Color"]` or poster's `["Size"]` just works — no hardcoded S/M/L. |
| Materials & processing window | `etsy-blueprints.ts` (`BLUEPRINT_MATERIALS`, `BLUEPRINT_PROCESSING_DAYS`) | Blueprint-keyed maps. |
| Variant price tiers | `packages/listing/src/constants.ts` (`PRINTIFY_VARIANT_PRICE_CENTS_BY_BLUEPRINT`) | Blueprint-keyed, with fallback. |
| Blueprint→provider pairing | `PRINTIFY_BLUEPRINT_PROVIDERS` | Validated on publish. |
| DB schema | migrations 002, 053 (`printify_blueprint_id INT`, `printify_variant_ids INT[]`, `printify_variant_catalog`) | No apparel-specific columns/constraints. The variant catalog already supports arbitrary axes. |

## 5. What's hardcoded to t-shirts (the actual work)

| # | What | Where | Fix |
|---|---|---|---|
| 1 | Blueprint/provider/variant IDs chosen | `packages/design/main.py:256–258, 337–339`; `packages/design/constants.py:7,14,17` | Resolve from brief's `product_type` via a blueprint registry instead of importing the Gildan constants. |
| 2 | Canvas dimensions fixed at 4500×5400 | `packages/design/constants.py:102` | New `BLUEPRINT_CANVAS_DIMENSIONS` map; thread the target into `image_processor.py` / `remask.py`. |
| 3 | Prompt "readability clause" hardcodes 14×16" full-chest | `packages/design/prompt_builder.py:391–396` | Per-blueprint readability/placement guidance map; dispatch in `build_image_prompt()`. |
| 4 | Etsy taxonomy is `"tshirt"`-only | `packages/shared/src/etsy-taxonomy.ts:4–8`; `packages/listing/src/publisher.ts:334` | Extend `ProductKey` + `PRODUCT_TAXONOMY_LABELS`; pass product type into `getTaxonomyId()` instead of the literal `"tshirt"`. |

---

## 6. Mockups for non-shirt products

This is the part that's in **much better shape than expected** — the multi-product mockup machinery already exists and is already blueprint-keyed. There are three mockup sources, in increasing order of operator effort:

### Source 1 — Printify (default, free, already product-agnostic)
Listing populates `design_packages.mockup_urls` + `mockups_from_actual_design=true` as a side effect of `createHiddenProduct()`. Printify renders mockups for **whatever blueprint** the product was created with, so mugs/posters get Printify mockups for free the moment we write the right blueprint ID. **No work — it follows from §5 item 1.**

### Source 2 — Dynamic Mockups (already integrated, already blueprint-keyed)
`packages/shared/src/dynamic-mockups.ts` is a working client (`renderMockup()` → `POST /api/v1/renders`, returns a CDN URL Etsy can stream directly). It composites our Supabase Storage design PNG into a template by URL — no upload step. Crucially it's driven by a **per-blueprint registry**:

```ts
// dynamic-mockups.ts:174
const DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT: Record<number, DynamicMockupsTemplate[]> = {
  145: [ { mockupUuid: "0e6cb32a-…", smartObjectUuid: "bf4fdfa9-…" } ],
};
```

The dashboard's **"Generate Dynamic Mockups"** button (`DynamicMockupsTrigger.tsx` → `generateDynamicMockups` action) already:
- reads the design's `printify_blueprint_id`,
- looks up its templates,
- renders **all** registered templates and appends every result to `mockup_urls`,
- disables itself with helper text when no template is registered for that blueprint.

**So enabling Dynamic Mockups for a mug is purely operator config — zero code:**
1. In the operator's Dynamic Mockups Library, pick/build a mug mockup.
2. Copy its `mockup_uuid` (template) and `smart_object.uuid` (the print slot).
3. Add an entry keyed by the mug's Printify blueprint id to `DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT`.

The button lights up for that blueprint automatically. (This map is the one spot that needs a code edit per product, and it's a one-line registry add — we should document it in CLAUDE.md alongside the other blueprint maps.)

### Source 3 — Add a mockup by direct link (already built)
The active-listing image panel (`EtsyImagePanel.tsx` → `app/api/listings/[id]/etsy-images/route.ts` `POST`) already lets the operator add an image **from a URL**, behind an SSRF host allowlist (the route trusts Printify, Supabase, and the Dynamic Mockups CDN host — see recent commits `4910620`, `1c7cd8b`). So "paste a mockup link from another site" is supported today; for a new mockup host we'd just add that host to the allowlist.

**Net mockup work for a new product type:** essentially none in code beyond the host allowlist — register a Dynamic Mockups template (config), and Printify mockups come for free. The carousel, Etsy upload (with `alt_text`), provenance flag, and 10-image cap are all product-agnostic already.

---

## 7. Proposed execution phases

### Phase 0 — Decision + variant catalog (blocking)
- Lock the §3 decision (recommend A).
- For each launch product, fetch real variant metadata from Printify:
  `GET /v1/catalog/blueprints/{id}/print_providers/{id}/variants.json`
  and seed `printify_variant_catalog` (migration 053 table) + the blueprint maps. Mirrors the known blocker in `PLAN_shirt_color_size_variants.md` — non-default variant IDs don't exist in the repo yet.

### Phase 1 — Product-type plumbing (TS + Python, backward-compatible)
- Migration: add `product_type TEXT NOT NULL DEFAULT 'tshirt'` to `trend_briefs` (Option A).
- Central `BLUEPRINT_REGISTRY` resolving `product_type → { blueprintId, providerId, defaultVariantIds, canvas, axes }`. Single source of truth; the scattered maps either read from it or get a sibling entry.
- Design (`main.py`): replace the three hardcoded Gildan constants (both the cache-hit path ~256 and processing-stub path ~337) with a registry lookup off the brief.
- Default everywhere = `tshirt` ⇒ **zero behavior change for existing briefs.**

### Phase 2 — Image generation per product (Python)
- `BLUEPRINT_CANVAS_DIMENSIONS` + thread target through `image_processor.py` / `remask.py`.
- `BLUEPRINT_READABILITY_CLAUSE` map; dispatch in `prompt_builder.py`. Mug/poster get placement-appropriate guidance instead of "full-chest 14×16".

### Phase 3 — Etsy taxonomy (TS)
- Extend `ProductKey` + `PRODUCT_TAXONOMY_LABELS`; pass `product_type` into `getTaxonomyId()` at `publisher.ts:334`. Extend the `etsy-mock.ts` taxonomy fixture beyond the T-Shirts branch.

### Phase 4 — Mockups (mostly config)
- Register Dynamic Mockups template(s) per new blueprint (§6 Source 2).
- Confirm Printify default mockups render (§6 Source 1).
- Add any new mockup host to the `etsy-images` POST allowlist if using Source 3.

### Phase 5 — Dashboard + tests
- Surface `product_type` in the Design/Builder UI (Option A picker) and on listing detail.
- Tests: status-transition + economics regression with a non-145 blueprint; inventory PUT for a single-axis product (mug `["Color"]`); taxonomy dispatch; canvas-dimension selection; default-`tshirt` regression across the pipeline.

---

## 8. Risks / open questions

- **Variant IDs are not in the repo** — same blocker as the color/size plan; must hit the Printify catalog API per blueprint (Phase 0).
- **Print-area geometry differs per product** — mug wraparound vs poster bleed vs shirt chest. The design model needs product-aware composition, not just a resize (Phase 2). This is the genuine design-quality risk and where most of the time goes.
- **Pricing floor** is generic (`price ≥ print_cost × 2.5`) but per-product economics differ — a $4 poster vs a $9 shirt changes the price target. Worth an explicit per-product price target, not just the floor.
- **Which products to launch?** Ties into CLAUDE.md Open Question "Printify blueprints at launch: tees only, or +mugs/posters?" — recommend starting with **one** non-apparel type (poster or mug) to exercise the full path end-to-end before fanning out.

---

## 9. TL;DR for the owner

- The plumbing is ~70% there; t-shirt is hardcoded in **4 spots** (blueprint pick, canvas size, prompt readability clause, Etsy taxonomy).
- **Mockups are basically solved already:** Printify mockups come free for any blueprint, Dynamic Mockups is integrated and blueprint-keyed (enabling a new product = pasting two UUIDs into a registry), and "add a mockup by link" already exists behind a host allowlist.
- The real work is (1) deciding where product type is set — recommend a `product_type` field on the brief — and (2) making image generation product-aware (canvas + placement guidance).
- First product: ~1–2 days. Each one after: ~an hour or two.

---

## Appendix A — Concrete mug spec (verified against live Printify catalog, 2026-05-30)

Pulled from the real Printify catalog API with the repo's `PRINTIFY_API_TOKEN`. This is the Phase-0 deliverable for **mug as the first non-shirt product.**

### Chosen blueprint
- **Blueprint 68 — "Mug 11oz"** (Generic brand, white ceramic). The canonical POD mug; classic 11oz white sublimation mug.
- **Print provider: 1 — SPOKE Custom Products** (the *only* provider for this blueprint, so no provider choice to make — contrast with the shirt's provider 3).

### Variants — this is the interesting part
```
GET /v1/catalog/blueprints/68/print_providers/1/variants.json
→ total variants: 1
  33719 | "11oz" | options: { size: "11oz" }
```
**One variant, single `size` axis, no color axis.** This is the simplest case in the whole catalog and a perfect first exercise of the generic machinery:
- `printify_variant_ids = [33719]`
- `BLUEPRINT_VARIATION_AXES[68] = ["Size"]` — single-axis. The Etsy inventory builder (`etsy-inventory.ts`) already handles arbitrary axes, but a 1-axis / 1-variant product is the cleanest possible regression test that it doesn't assume Color×Size.
- No Printify catalog fetch needed beyond this — unlike the shirt color/size plan, the mug's full variant set is just this one ID.

### Costs / timing (verified where the API exposes it)
| Field | Value | Source |
|---|---|---|
| Shipping (US, first item) | **$6.39** | `…/shipping.json` → `first_item.cost: 639`. (Second US profile shows $6.99 — likely expedited; use $6.39 standard.) Add'l item $2.99. |
| Handling / processing time | **10 days** | `…/shipping.json` → `handling_time: { value: 10, unit: "day" }` |
| Print cost (what the shop pays Printify) | **TBD at product-create — ~$4–5 typical** | **Not exposed by the catalog API.** Only returned as `variants[].cost` in the `POST …/products.json` response. Must be read from the first real (or `is_visible=false`) product creation and pinned into `BLUEPRINT_PRINT_COST_USD[68]`. Same caveat as variant IDs in `PLAN_shirt_color_size_variants.md`. |

### Resulting map entries to add
```ts
// packages/ledger/src/constants.ts
BLUEPRINT_PRINT_COST_USD[68]   = /* confirm from product-create response, ~4.5 */;
BLUEPRINT_SHIPPING_COST_USD[68] = 6.39;

// packages/shared/src/etsy-blueprints.ts
BLUEPRINT_VARIATION_AXES[68]   = ["Size"];      // single axis, single variant
BLUEPRINT_MATERIALS[68]        = ["Ceramic"];
BLUEPRINT_PROCESSING_DAYS[68]  = { min: 10, max: 14 };  // 10-day handling + Etsy buffer

// packages/listing/src/constants.ts
PRINTIFY_BLUEPRINT_PROVIDERS[68] = 1;            // SPOKE Custom Products
PRINTIFY_VARIANT_PRICE_CENTS_BY_BLUEPRINT[68] = /* set retail; e.g. 1799 for ~3× once print cost confirmed */;
```
```python
# packages/design/ registry (Option A)
68: { blueprint_id: 68, provider_id: 1, default_variant_ids: [33719],
      canvas: (2700, 1120),   # VERIFIED — SPOKE "front" print area, dye-sublimation (see Print area below)
      product_type: "mug" }
```

### Economics sanity check (mug vs the 2.5× floor)
- Print cost ~$4.50 + shipping $6.39 absorbed = **~$10.89 landed cost** before Etsy fees.
- At the shirt's $24.99 that's fine, but a mug typically retails **$16.99–$19.99**. At $17.99: Etsy fees ≈ $1.80 → net ≈ **$5.39 (~30%)**. The `2.5×` floor on print cost alone ($4.50 × 2.5 = $11.25) is *not* the binding constraint here — **shipping is.** This confirms the §8 note: mugs need a per-product **price target**, not just the print-cost floor, because the $6.39 shipping the shop eats dwarfs the print cost.

### Print area (VERIFIED — the real dimensions)
```
GET /v1/catalog/blueprints/68/print_providers/1/variants.json
→ variants[0].placeholders:
  [ { position: "front", decoration_method: "dye-sublimation", width: 2700, height: 1120 } ]
```
- **Print canvas = 2700 × 1120 px**, a single `front` placeholder (the full wrap on an 11oz mug). Landscape, ~2.41:1 aspect — the **inverse** of the shirt's tall 4500×5400 (0.83:1) portrait. This is the §8 "not a resize" case made concrete.
- **Decoration method: dye-sublimation** — full-bleed edge-to-edge wrap is fine (no transparency requirement like the shirt's chest print); the art can fill the whole 2700×1120 rectangle.
- Only one placeholder, so no front/back split to model. Design generates a single landscape image sized to 2700×1120.
- `prompt_builder.py` needs mug-appropriate placement guidance: **centered landscape composition, ~2.4:1, with safe margins** (the wrap meets at the handle, so avoid critical detail at the extreme left/right edges and keep focal content in the middle ~2200px). This replaces the full-chest "14×16 / 10–12 width" readability clause for blueprint 68.

### One-line summary
Mug = **blueprint 68, provider 1, variant [33719], single Size axis, print area 2700×1120 (front, dye-sub), $6.39 US shipping, 10-day handling.** Only remaining unknown is print cost (read it off the first product-create response). Mechanically the easiest possible second product; the only non-trivial work is the 2.4:1 wraparound canvas + prompt guidance.
