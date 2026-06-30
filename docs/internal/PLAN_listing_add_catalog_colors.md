# Plan — Add Any Catalog Color to an Unpublished Listing

**Status:** IMPLEMENTED (v1) — 2026-06-02. Typecheck + lint clean; dashboard 181 /
listing 153 / shared 144 tests green.
**Date:** 2026-06-02
**Scope:** Listing surface only. Builds on the shipped color/size variants feature
(`PLAN_shirt_color_size_variants.md`, Phases 0–5).

> **UX refinement during build:** the editor was reworked to operate in
> **colors × sizes** space (reusing the Design page's `VariantPicker` +
> `ColorSwatchSelect`) rather than a flat list of per-variant checkboxes. It
> resolves the colors × sizes cross-product to catalog variant ids on submit.
> This gives the listing surface true parity with the Design review card and
> scales to 63 colors. Validation/agent changes (§3, §4a–c) are unchanged.

---

## 1. Goal

On the **listing detail page**, for an **unpublished** listing (`needs_review` or
`pending_publish`), let the operator offer **any color/size from the SwiftPOD
catalog** (blueprint 145 / provider 39 — 63 colors × 9 sizes), not just narrow the
set the design package shipped with. After changing the set, the operator clicks
**Recreate** to rebuild the Printify product, mockups, and inventory.

**Explicit non-goal (this plan):** changing colors on a **live** (`active`) listing.
See §7 — your instinct is right, it's a separate, riskier flow. Deferred.

---

## 2. Why this is small and clean (the load-bearing facts)

1. **Color never touches image generation.** The design PNG is color-agnostic.
   Color = which Printify variant IDs are used. (Confirmed in prior plan.)
2. **Mockups + variant labels are a Listing artifact, regenerated on recreate.**
   `createHiddenProduct(variantIds)` (`packages/listing/src/printify.ts:48`) creates
   the product from *whatever IDs we pass* and `extractVariantOptions` (`:113`)
   resolves labels for exactly those IDs. `publishOne` then writes
   `design_packages.printify_variants` + `mockup_urls` from that response
   (`publisher.ts:235-242`). So added colors get correct labels + mockups for free
   on recreate. **No Design dependency.**
3. **The recreate path already applies the per-listing override.**
   `recreatePrintifyProduct` (`actions/listings.ts:660`) only resets the row to
   `status='pending'`; `publishOne` re-reads `selected_variant_ids` and builds the
   product from it (`publisher.ts:198-223`).

The **only** thing blocking "add a color" today is a subset guard: three sites
require `selected_variant_ids ⊆ design.printify_variant_ids`. We widen the
validation universe to **the catalog** instead.

---

## 3. Current validation sites (the subset guard)

| # | File / line | Today validates against | Change |
|---|---|---|---|
| A | `dashboard/lib/actions/listings.ts:695-722` (`updateListingVariants`) | design's `printify_variant_ids` | catalog set for design's blueprint/provider |
| B | `listing/src/publisher.ts:207-214` (`publishOne` create path) | `designVariantIds` | catalog set for design's blueprint/provider |
| C | `listing/src/publisher.ts:575-583` (`resumePublish`) | `printify_variants` (post-create labels) | **NO CHANGE** — correct as-is |

`validateVariantIds(selected, available)` (`packages/shared/src/variant-selection.ts`)
is generic — we only change *what we pass as `available`*. The validator itself is
unchanged.

**Why C stays:** `resumePublish` runs on `pending_publish` and builds Etsy inventory
from `design_packages.printify_variants` (the last created product's labels). If the
operator added a color but did **not** recreate, those IDs aren't in
`printify_variants` yet, so C correctly throws → forces a recreate. That is exactly
the guarantee we want: **any set change requires Recreate before publish.**

---

## 4. Changes

### 4a. New catalog query — `dashboard/lib/queries/variants.ts`
Add `getCatalogVariants(blueprintId, providerId): Promise<CatalogVariant[]>` where
`CatalogVariant = { id: number; color: string; size: string }` (`variant_id AS id`,
`is_available = true`, server-only / service client). This is the editor's universe
**and** the validation set for site A. Existing `getVariantOptions` stays.

### 4b. Action `updateListingVariants` (site A)
Replace the read of `design_packages.printify_variant_ids` with the catalog ID set
(via `getCatalogVariants` for the listing's design blueprint/provider — both already
on the joined row). Validate `selected ⊆ catalogIds`. Everything else (NULL = inherit,
write `selected_variant_ids`) unchanged.

### 4c. Publisher `publishOne` (site B)
Read `printify_variant_catalog` for `design.printify_blueprint_id` /
`printify_print_provider_id` (the publisher already has `db`), build the catalog ID
set, and `validateVariantIds(selectedVariantIds, catalogIds)`. Keep
`variantIds = selectedVariantIds?.length ? selectedVariantIds : designVariantIds`.
A selection that is a **superset** of the design set now flows straight into
`createHiddenProduct`. (Defense-in-depth: the agent re-validates even though the
dashboard already did.)

### 4d. UI — rework `VariantOverrideEditor.tsx`
- New props: `catalogVariants: CatalogVariant[]` (universe), `designVariantIds:
  number[]` (for "reset to design default"), `selectedVariantIds: number[] | null`.
  Drop reliance on `printify_variants` for labels (added colors aren't there yet) —
  labels come from the catalog rows.
- Render **grouped by color**, each color a row of **size** checkboxes (color × size
  grid). Pre-check `selectedVariantIds ?? designVariantIds`. Pre-expand colors that
  are already offered; collapse the rest behind a **color filter input** (63 colors
  is too many to dump flat).
- Controls: **Reset to design default** (check = `designVariantIds`), **Clear
  override** (submit empty → NULL = inherit design set), Select-all-sizes per color.
- Submit checked IDs as repeated hidden `selectedVariantIds` inputs (unchanged
  pattern). `noneChecked` stays disabled.
- Update the warning note: *"Adding or narrowing colors here requires Recreate so the
  Printify product, mockups, and Etsy inventory match the new set."*

### 4e. Page wiring — `app/listings/[id]/page.tsx:205-214`
Call `getCatalogVariants(design.printify_blueprint_id, design.printify_print_provider_id)`
and pass `catalogVariants` + `designVariantIds` to the editor. Gate unchanged
(`needs_review` || `pending_publish`).

### 4f. Etsy payload preview — `lib/queries/etsy-preview.ts`
v1: **leave as-is** (it filters `printify_variants`, i.e. the *current* product).
Add a one-line note in the preview card: *"Added colors appear after Recreate."*
(Making the preview catalog-aware pre-recreate is logged as an optional follow-up in
§7 — not worth the inventory-rebuild duplication now, since Recreate is mandatory.)

---

## 5. Tests

- `variants.ts` — `getCatalogVariants` returns mapped `{id,color,size}`, filters
  `is_available` (mock the service client, mirror existing `getVariantOptions` test).
- `updateListingVariants` — accepts a catalog id **outside** the design set; rejects
  an id **not in** the catalog. (Mock catalog read.)
- `publisher.ts` — `publishOne` with `selected_variant_ids` a **superset** of the
  design set calls `createHiddenProduct` with the superset; rejects a non-catalog id.
- `VariantOverrideEditor` — grouped render, pre-check = selected∪design, submit emits
  checked IDs, Clear override emits none. (Match existing dashboard component-test
  setup.)
- Full regression: `npm run typecheck`, dashboard + listing + shared vitest, and the
  Python suites stay green (no Python change expected; verify `ruff`/`pyright` only if
  any `.py` is touched — none planned). Rebuild `shared` dist before TS typecheck
  (known stale-dist footgun from the prior plan).

**No migration** — `selected_variant_ids` is already `INT[]`; catalog already seeded.

---

## 6. Risks / caveats

- **Cost model:** colors don't change cost. Adding **4XL/5XL** widens the existing
  flat-`print_cost` under-protection caveat (already accepted as a v1 limitation in
  the prior plan) but does **not** change `validatePricingFloor` logic. Not a blocker;
  noted.
- **Mandatory recreate:** if the operator saves an added color and clicks Approve
  without Recreate, `resumePublish` (site C) throws a clear error. We surface this in
  the UI note up front so it's expected, not a surprise.
- **Shared `printify_variants` on the design package:** recreate overwrites it from
  the new product. With one listing per design (current reality) this is fine. If a
  design ever backs multiple listings, the last recreate wins on the shared row — out
  of scope here, flagged.

---

## 7. The live-listing question (deferred — your call later)

You're essentially right. Etsy *does* allow a `PUT /listings/{id}/inventory` on an
`active` listing without deleting it, so a true "take it down" isn't strictly forced
by Etsy. But to change colors on a live listing we'd still have to: recreate the
Printify product (new variant IDs + mockups) → re-run the full compliance gate →
PUT new Etsy inventory → re-upload mockups, all against a listing buyers can see.
That's a riskier, multi-step "revise live listing" flow with partial-failure states
mid-revision. The safe, simple version is exactly your instinct: deactivate →
recreate → republish (reuses this plan's path end-to-end). Recommend shipping the
unpublished case first; if you want live edits later, we add a dedicated "Revise live
listing" action with its own guardrails.

---

## 8. Build order

1. `getCatalogVariants` query + test.
2. `updateListingVariants` validation swap + test (site A).
3. `publisher.ts` validation swap + test (site B).
4. `VariantOverrideEditor` rework + test (4d).
5. Page wiring (4e) + preview note (4f).
6. Full typecheck + test sweep; manual UI smoke on a `needs_review` listing
   (add a non-default color → Save → Recreate → confirm new mockups + Etsy preview).
