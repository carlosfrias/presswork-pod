# Plan — T-Shirt Color & Size Variants (Design + Listing)

**Status:** Phase 0 COMPLETE ✅ — Phases 1–6 pending approval.
**Date:** 2026-05-30
**Author:** Claude (orchestrated research workflow, 6 parallel subsystem readers)

> ### Progress log
> - **Phase 0 done (2026-05-30):** `printify_variant_catalog` table created + applied to cloud (`053`), seed script written, catalog seeded & verified.
> - **Provider changed → SwiftPOD (id 39).** The original provider (Marco Fine Arts, id 3) stocks only 2 colors. A 20-provider comparison led to adopting **SwiftPOD: 63 colors × 9 sizes (XS–5XL), $4.29 US ship, fixed provider for consistent color/quality.** Catalog now holds 419 SwiftPOD variants (Marco rows removed).
> - **Key finding:** Printify variant IDs for blueprint 145 are **blueprint-scoped, not provider-scoped** — White S–2XL = `38163/38177/38191/38205/38219` under both providers; 3XL = `42120`. So existing White IDs stay valid; only `print_provider_id` (3 → 39) must change.
> - **SwiftPOD base cost confirmed (2026-05-30, via throwaway product probe):** S/M/L/XL = **$10.09**, 2XL = **$11.53**, 3XL = **$12.76**. US shipping = $4.29. (Was $8.50 flat for Marco.)
>   - **Pricing-floor impact:** 2.5× floor for S–XL = **$25.23** (was $21.25). The current **$24.99 price point now FAILS** `validatePricingFloor` by $0.24. Listings must move to **≥ $25.99** (target $26.99–$27.99 for a healthy 3× on the base). Per-unit at $25.99: print $10.09 + ship $4.29 + Etsy fees ~$2.92 → **net ~$8.69 (33%)**.
>   - **Size-variable cost:** 2XL/3XL carry upcharges, so a single flat `print_cost` slightly under-protects those sizes. v1 keeps a flat base ($10.09) for the floor + Ledger and flags 2XL/3XL; making cost per-variant is a follow-up.

---

## ⏯ NEXT SESSION — START HERE

**Done & shipped (on `main`):** Phase 0 — `printify_variant_catalog` table (migration `053`, applied to cloud) + seed script (`scripts/seed-printify-variant-catalog.ts`). Cloud catalog holds **419 SwiftPOD variants** (63 colors × 9 sizes), verified.

**Decisions locked (do not re-litigate):**
- Provider = **SwiftPOD (39)**. Variant IDs are blueprint-scoped → White S–2XL = `38163/38177/38191/38205/38219`, 3XL = `42120`.
- Costs: base **$10.09** (S–XL), 2XL $11.53, 3XL $12.76; ship $4.29.
- New default retail **$26.99**; Scout range **$25.99–$34.99**.
- Default offered set = White + S/M/L/XL/2XL. Colors selectable = full SwiftPOD catalog. Selection on `trend_briefs`, per-listing override on `listings.selected_variant_ids`.

**Next action = Phase 1** (was awaiting owner go-ahead at session end):
1. **Phase 1a** — flip provider constants (3→39) in `packages/design/constants.py` + `packages/listing/src/constants.ts`; update cost constants to $10.09/$4.29 in Listing + Ledger; re-baseline `packages/dashboard/lib/scout/generate-niche.ts` to $26.99 / $25.99–$34.99.
2. **Phase 1b** — migrations `054` (`trend_briefs.shirt_colors[]`,`shirt_sizes[]`) + `055` (`listings.selected_variant_ids[]`) + zod/pydantic model updates. Apply with `supabase db push` (migration-history drift was repaired 2026-05-31 — see note below).
Then Phases 2–6 (Design agent, Listing agent, dashboard pickers, tests).

**✅ Repo cleanup done (2026-05-31), both formerly-blocking gotchas resolved:**
- **Migration-history drift — FIXED.** Cloud `schema_migrations` had 046–053 recorded as timestamp versions (046–049, 052, 053) with 050/051 absent entirely, so `supabase db push` saw 046+ as unapplied. Repaired via `supabase migration repair --status applied 046…053` + `--status reverted` on the 6 orphan timestamp rows (history table only — schema untouched; all 046–053 changes were already live). `supabase migration list` now shows clean 001–053 Local=Remote and `db push --dry-run` reports "up to date." **Use `supabase db push` for 054/055.**
- **CI red on `main` — FIXED** (commit on `main`). `publish.test.ts` asserted the `dist/publish.js` build artifact exists; CI runs vitest without `tsc -b` so it failed (green only locally with a stale `dist/`). Rewrote the guard to validate the build-independent invariant (export wired to `./dist/*.js` + backing `src/*.ts` source exists + matching basenames).

---

## 1. Goal

Let an operator choose which **shirt colors** and **sizes** a design/listing offers.

- **Design surface** — set color + size options per design. Default = **White, all 5 sizes (S/M/L/XL/2XL)**, with White/Medium pre-highlighted.
- **Listing surface** — selection set in Design **carries over**; the operator can **override per individual listing** before publish.
- **Colors available** = the full SwiftPOD catalog for Gildan 64000 (provider 39): **63 colors × 9 sizes (XS–5XL)**.

---

## 2. Key finding that shapes everything

**Shirt color/size is pure product metadata — it never touches image generation.**
The design PNG is a transparent, color-agnostic, 4500×5400 print file. Color/size only determine **which Printify variant IDs** get written to `design_packages.printify_variant_ids`. The entire downstream pipeline (Printify product create → label resolution → Etsy inventory PUT with Color=property 513 / Size=property 514) **already handles arbitrary variant subsets generically.**

So this feature is **not** an image-generation change. It is:
1. A **variant catalog** (we only have 5 White IDs today — need the rest).
2. **Selection fields** + UI in two places.
3. **Resolving** a (colors × sizes) selection into the right variant IDs.

### The one hard blocker
`packages/design/constants.py:17` hardcodes the only known variant IDs:
```python
GILDAN_64000_VARIANT_IDS = [38163, 38177, 38191, 38205, 38219]  # White S/M/L/XL/2XL
```
Non-white variant IDs **do not exist anywhere in the codebase**. They must be fetched from the Printify catalog API:
```
GET /v1/catalog/blueprints/145/print_providers/3/variants.json
```

---

## 3. Current data flow (verified)

```
trend_briefs (operator sets image_description, image_model, bg_mode, color_palette)
   │  Design agent claims status='approved'
   ▼
design_packages
   • printify_blueprint_id      = 145         (constant)
   • printify_print_provider_id = 3           (constant)
   • printify_variant_ids       = [5 White]   (constant)  ◄── ONLY hardcoded thing
   • printify_variants (JSONB)  = NULL until Listing runs
   │  Listing agent claims status='approved' (claim RPC inserts listings row)
   ▼
Printify createHiddenProduct(variantIds = design.printify_variant_ids)
   • Printify response → extractVariantOptions() resolves IDs → [{id, values:['white','s']}]
   • written back to design_packages.printify_variants
   ▼
Etsy publish → buildInventoryFromDesign(printify_variants)
   • each variant → 1 Etsy product, property 513=Color, 514=Size
   • axis order from BLUEPRINT_VARIATION_AXES[145] = ['Color','Size']
```

Key files:
- `packages/design/constants.py:7-17`, `packages/design/main.py:256-262` (cache-hit) & `333-346` (normal) — variant IDs written.
- `packages/listing/src/publisher.ts:176-201` — reads `design.printify_variant_ids` verbatim, writes back `printify_variants`.
- `packages/listing/src/printify.ts:61-151` — product create + `extractVariantOptions`.
- `packages/shared/src/etsy-inventory.ts:53-135` — `buildInventoryFromDesign` (pure, axis-generic).
- `packages/shared/src/etsy-blueprints.ts:35-50` — `BLUEPRINT_VARIATION_AXES`, `ETSY_CUSTOM_PROPERTY_IDS`.
- `packages/dashboard/components/design/DesignReviewCard.tsx` — Design review UI (already has palette/style/model/bg pickers).
- `packages/dashboard/lib/actions/design.ts:276` (`regenerateDesign`), `:123` (`approveDesign`).
- `packages/dashboard/app/listings/[id]/page.tsx` + `packages/dashboard/lib/actions/listings.ts:650` (`recreatePrintifyProduct`).
- Highest migration = `052`; next = `053`.

---

## 4. Design decisions (locked + recommended)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Default offered set | White + all 5 sizes | Confirmed; preserves today's behavior, best for sales. |
| D2 | Colors available | Full SwiftPOD catalog (63 colors) | Provider 3 had only 2 colors → switched to SwiftPOD (39) after 20-provider comparison. Seeded. |
| D3 | Catalog storage | **DB table** `printify_variant_catalog` | Single source of truth readable by **both** Python (Design) and TS (dashboard/Listing); add colors without a deploy. |
| D4 | Where the *selection* lives | **`trend_briefs.shirt_colors[]` + `shirt_sizes[]`** | Survives Regen (like palette/style/image_model, which all live on `trend_briefs`). Design agent resolves → variant IDs. |
| D5 | Per-listing override | **`listings.selected_variant_ids int[]`** (NULL = inherit) | Clean carry-over: NULL means "use design's set"; non-null is the operator's per-listing override. |
| D6 | Selection narrows… | **Both** Printify product **and** Etsy inventory | Simpler model; the existing `recreatePrintifyProduct` action is the natural "apply change" trigger. |
| D7 | Selection granularity | Two multi-selects (colors × sizes) → cartesian, intersected with catalog | Matches the request ("set colors and size options"); only valid combos survive. |
| D8 | Image generation | **No change** | PNG is color-agnostic. |

---

## 5. Foundational artifact — variant catalog (do first)

### Migration `053_printify_variant_catalog.sql`
```sql
CREATE TABLE printify_variant_catalog (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id           INT  NOT NULL,
  print_provider_id      INT  NOT NULL,
  variant_id             INT  NOT NULL,
  color                  TEXT NOT NULL,
  size                   TEXT NOT NULL,
  is_available           BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, print_provider_id, variant_id)
);
CREATE INDEX idx_pvc_lookup ON printify_variant_catalog (blueprint_id, print_provider_id, color, size);
-- reuse update_timestamp() trigger (defined in migration 001 — do NOT redefine)
CREATE TRIGGER trg_pvc_updated BEFORE UPDATE ON printify_variant_catalog
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
```

### Seed script `scripts/seed-printify-variant-catalog.ts`
- Calls `GET /v1/catalog/blueprints/145/print_providers/3/variants.json` via the existing `packages/shared/src/printify-http.ts` client (no new fetch sites — Printify rule).
- Parses each variant's `options` → `{color, size}` (validate with zod), upserts into `printify_variant_catalog`.
- Idempotent (upsert on the unique key). Re-runnable when the catalog changes.
- **Verification:** confirm the 5 known White IDs (38163/38177/38191/38205/38219) map to White S/M/L/XL/2XL — guards against an axis/parsing flip.

This table becomes the authoritative color/size ⇄ variant_id map for both languages.

---

## 6. Implementation phases

### Phase 0 — Catalog (prerequisite)
- Migration `053` + seed script (Section 5).
- Push to cloud Supabase, run seed, verify White IDs.

### Phase 1a — Provider switch to SwiftPOD (39)
Variant IDs are blueprint-scoped, so this is mostly constant changes — but touches the live pipeline, so do it as one coherent step:
- `packages/design/constants.py`: `GILDAN_64000_PRINT_PROVIDER_ID = 3 → 39`. Keep `GILDAN_64000_VARIANT_IDS` as White S–2XL (`38163…38219`) — still valid under SwiftPOD; optionally add 3XL `42120` per D1.
- `packages/listing/src/constants.ts`: `PRINTIFY_BLUEPRINT_PROVIDERS = { 145: 39 }`; keep `assertBlueprintSupported` consistent.
- **Update cost constants to SwiftPOD (confirmed):** `GILDAN_64000_PRINT_COST_USD` 8.50 → **10.09** (Listing floor), `BLUEPRINT_PRINT_COST_USD[145]` 8.50 → **10.09** and `BLUEPRINT_SHIPPING_COST_USD[145]` 4.50 → **4.29** (Ledger). Raises the 2.5× floor to **$25.23**.
- **Re-baseline pricing → new default $26.99** (DECIDED): net ~$9.60/unit (36%), clears the floor. Update `packages/dashboard/lib/scout/generate-niche.ts` — replace the "$24.99 typical / $19.99–$34.99 / default 24.99" guidance with **default $26.99, range $25.99–$34.99**. Operator can still set each listing's price (floor-validated). Confirm no other live flow assumes $24.99.
- Existing live listings: already created under provider 3 with shared White IDs; new products will be created under 39. No back-migration needed unless re-creating a product.

### Phase 1b — Schema for selection + override
**Migration `054_brief_shirt_variant_selection.sql`**
```sql
ALTER TABLE trend_briefs
  ADD COLUMN shirt_colors TEXT[] NOT NULL DEFAULT ARRAY['White'],
  ADD COLUMN shirt_sizes  TEXT[] NOT NULL DEFAULT ARRAY['S','M','L','XL','2XL'];
```
**Migration `055_listing_variant_override.sql`**
```sql
ALTER TABLE listings
  ADD COLUMN selected_variant_ids INT[] NULL;  -- NULL = inherit from design_packages
```
- Update zod/pydantic models: `packages/shared/src/types.ts` (`ListingSchema`, brief types), `packages/shared_py/models.py` (`TrendBrief`).
- Regenerate Supabase TS types if used by dashboard.

### Phase 2 — Design agent (Python) resolves selection → variant IDs
- New helper in `packages/design/` (e.g. `variant_catalog.py`): given `(blueprint_id, provider_id, colors[], sizes[])`, query `printify_variant_catalog` → list of `variant_id`s. Fallback to `GILDAN_64000_VARIANT_IDS` only if the catalog query returns empty (defensive).
- `main.py:256-262` (cache-hit) **and** `333-346` (normal): replace the hardcoded `GILDAN_64000_VARIANT_IDS` write with the resolved list from the claimed brief's `shirt_colors`/`shirt_sizes`. Blueprint/provider stay constant for now.
- `constants.py`: keep `GILDAN_64000_VARIANT_IDS` as the documented fallback default.
- **No change to image generation / prompt builder.**

### Phase 3 — Listing agent (TS) honors override
- `publisher.ts` `publishOne` / `createHiddenProduct` call (~`:176-182`): variant IDs = `listing.selected_variant_ids ?? design.printify_variant_ids ?? []`.
- `resumePublish` JOIN (~`:493-520`): also select `listings.selected_variant_ids`; when non-null, **filter `printify_variants`** to those IDs before `buildInventoryFromDesign` (keeps that pure function override-free).
- New guard `validateVariantIds()` (shared): every id in `selected_variant_ids` must exist in `design_packages.printify_variant_ids` (and in the catalog for that blueprint/provider). Throw before Printify/Etsy calls.
- `recreatePrintifyProduct` path must also honor `selected_variant_ids` (it currently always uses the full design set) — this is the "apply my override" trigger.

### Phase 4 — Dashboard: Design surface
- New `VariantPicker` component (colors multi-select + sizes multi-select), options sourced from `printify_variant_catalog` (distinct colors/sizes for blueprint 145/provider 3).
- Mount in `DesignReviewCard.tsx` after `BgRemovalPicker` (~`:416`). Initialize from brief's `shirt_colors`/`shirt_sizes` (default White / all sizes).
- Serialize as hidden JSON inputs on the **Regen** and **Approve** forms (same pattern as `color_palette` at `:477`).
- `regenerateDesign` (`design.ts:276`) & `approveDesign` (`:123`): parse + write `shirt_colors`/`shirt_sizes` to `trend_briefs` (survives regen). Expose fields on `DesignReviewItem` (`lib/queries/design.ts:18`).

### Phase 5 — Dashboard: Listing surface (per-listing override)
- New `VariantOverrideEditor` in `app/listings/[id]/page.tsx` Actions card (~`:232`), shown when status ∈ `needs_review` | `pending_publish`.
- Renders the **inherited** set (from `design_packages.printify_variant_ids` + catalog labels) with checkboxes; operator can deselect colors/sizes.
- New server action `updateListingVariants` (`listings.ts`): writes `listings.selected_variant_ids` (or NULL to reset to inherit). Same `assertOwner()` + `idSchema.parse()` + `serviceClient()` pattern as siblings.
- Adjacent **"Recreate Printify product"** button (already at `listings.ts:650`) re-applies the subset. Surface a clear note: changing colors → mockups must regenerate.

### Phase 6 — Tests + verification
- **Python:** catalog resolver (colors×sizes → IDs), default fallback, cache-hit path writes resolved IDs.
- **TS:** `selected_variant_ids ?? design ids` precedence; `printify_variants` filtering in `resumePublish`; `validateVariantIds` rejects ids outside the design set; `buildInventoryFromDesign` still maps a 2-color × 5-size set correctly (Color/Size axes).
- **Integration (cloud Supabase):** seed catalog → brief with shirt_colors=['White','Black'] → Design writes 10 IDs → Listing (mock mode `ETSY_MOCK_MODE=true`) creates Printify product (real Printify) → `printify_variants` has 10 rows → Etsy inventory preview shows Black/White × sizes.
- **Dashboard:** manual smoke of both pickers; Etsy payload preview panel reflects selection.

---

## 7. Carry-over & override semantics (the core UX contract)

```
Design picker  ──writes──►  trend_briefs.shirt_colors / shirt_sizes   (survives Regen)
                                  │ Design agent resolves via catalog
                                  ▼
                       design_packages.printify_variant_ids           ◄── the carried-over default
                                  │
        listings.selected_variant_ids = NULL  ──►  inherit design's set
        listings.selected_variant_ids = [..]  ──►  per-listing override (subset)
                                  │ recreatePrintifyProduct applies it
                                  ▼
                       Printify product + Etsy inventory (narrowed)
```

- **Inherit by default** (NULL). Operator only sets `selected_variant_ids` to *narrow* a specific listing.
- Override is always a **subset** of the design's variant IDs (enforced by `validateVariantIds`).

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `printify_variants` is NULL until a Printify product exists — listing picker can't show labels pre-create | Source picker labels from `printify_variant_ids` + `printify_variant_catalog`, not `printify_variants`. |
| Changing color after mockups exist → stale mockups (wrong garment color) | UI note + require `recreatePrintifyProduct`; mockups regenerate from the new variant set. `mockups_from_actual_design` re-set on rebuild. |
| `recreatePrintifyProduct` currently ignores any override | Phase 3 makes it honor `selected_variant_ids`. |
| 2XL/3XL **print-cost upcharge** — `BLUEPRINT_PRINT_COST_USD`/pricing floor are flat per blueprint | Out of scope for v1 (today already ships S–2XL at flat cost → no regression). Flag: if 3XL+ added, make cost per-variant and revisit the 2.5× floor + Ledger margin. |
| `BLUEPRINT_VARIATION_AXES[145]=['Color','Size']` order is unvalidated; wrong order silently mislabels Etsy | Seed-script verification asserts known White IDs resolve to correct color/size; integration test checks a 2-color set. |
| Large variant counts (many colors × 5 sizes) → big Etsy inventory PUT | Note only; no cap today. Add a soft cap + `log()` if a design selects an unusually large grid. |
| Design **Regen** could overwrite operator selection | Selection lives on `trend_briefs` and is re-read each run → preserved (matches palette/style behavior). |

---

## 9. Out of scope (v1)
- Additional blueprints (mugs/posters) — schema is now blueprint-keyed and ready, but no new blueprint added.
- Per-variant pricing / size upcharges.
- Per-color distinct artwork or print placement (single transparent PNG covers all colors).
- Auto-correlating mockup filtering to selected colors (operator still picks mockups via existing `selectedMockupUrls`).

---

## 10. Migrations summary
- `053_printify_variant_catalog.sql` — catalog table (+ seed script).
- `054_brief_shirt_variant_selection.sql` — `trend_briefs.shirt_colors[]`, `shirt_sizes[]`.
- `055_listing_variant_override.sql` — `listings.selected_variant_ids int[]`.

(054 + 055 may be combined into one migration if preferred.)

---

## 11. Model / cost note
All research ran on **Sonnet** (6 parallel readers) — high ROI for code mapping, no Opus needed. Implementation phases are mechanical-to-moderate; recommend **Sonnet** for the build with targeted review. No Opus required for this feature.

---

## 12. Suggested execution order
1. Phase 0 (catalog table + seed + verify) — unblocks everything.
2. Phase 1 (schema + models).
3. Phases 2 & 3 in parallel (Python Design / TS Listing).
4. Phases 4 & 5 (dashboard UI).
5. Phase 6 (tests + cloud integration smoke).

> **Approval gate:** confirm this plan, then I'll execute. Plan approval ≠ execution approval — say the word and I'll start at Phase 0.
