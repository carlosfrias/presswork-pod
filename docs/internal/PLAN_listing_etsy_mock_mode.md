# Listing Agent — Etsy Mock-Mode Bridge + POD Enrichment

## Context

The listing agent is much further along than the unblocked work suggests:

- `packages/shared/src/etsy-api.ts` already wraps `createDraftListing`, `uploadListingImage`, `activateListing` with Bottleneck rate limiting, exponential retry, `Retry-After` parsing, and Zod-validated payloads (`EtsyListingCreateInputSchema`).
- `packages/shared/src/etsy-auth.ts` does OAuth refresh with module-scope coalescing and dead-token alerting.
- `packages/shared/src/etsy-taxonomy.ts` resolves and caches `taxonomy_id` per product key into the `config` table.
- `packages/listing/src/publisher.ts` runs the full claim → copy → Printify product → human review → resume → Etsy publish loop with checkpoint/resume and a 3-strike retry budget.
- An MSW-driven integration test (`packages/listing/tests/integration/publisher-flow.test.ts`) already covers happy path, retryable failure, and exhausted retries against a live local Supabase.

What blocks an end-to-end exercise *outside* of Vitest:

1. **No mock-mode flag** — running `ts-node packages/listing/src/index.ts` against a real cloud Supabase row requires real Etsy creds, and `getSettings()` (`packages/shared/src/config.ts:8-23`) treats them as required strings. Even with junk values, `etsyFetch` hits `openapi.etsy.com` and 401s.
2. **No real Etsy variants** — the Printify product is created with S/M/L variants and `printify_variants` is persisted to `design_packages`, but the Etsy listing is published with a single flat `price`. Buyers can't pick a size on the Etsy side. This is the canonical missing POD piece.
3. **No image alt text, materials, or processing-time fields** — small but standard POD niceties.
4. **No "what will we send to Etsy" preview** in the dashboard — humans approve at `needs_review` without seeing the actual payload.

The intent is to ship the bridge so the entire publish path is exercisable today and becomes a one-flag flip the moment Etsy creds land.

## Approach

Three coordinated changes, all behind one new flag (`ETSY_MOCK_MODE=true`):

### A. Mock-mode bridge at the shared HTTP boundary

Add the toggle in one place — `packages/shared/src/etsy-api.ts` — so every call site (`createDraftListing`, `uploadListingImage`, `activateListing`, `getReceipt`, `listReceipts`, `getTaxonomyId`, taxonomy fetch, plus the new inventory PUT) inherits it for free. Same for `getValidAccessToken` in `etsy-auth.ts` so token refresh short-circuits.

Mechanism:

- Extend `SettingsSchema` (`packages/shared/src/config.ts`) with `ETSY_MOCK_MODE: z.coerce.boolean().default(false)`.
- When `ETSY_MOCK_MODE=true`, loosen the required-field check on `ETSY_API_KEY`, `ETSY_API_SECRET`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN` (allow `"mock"` placeholder via a `.refine()` that accepts the literal). `ETSY_SHOP_ID`, `ETSY_SHIPPING_PROFILE_ID`, `ETSY_PRODUCTION_PARTNER_ID`, `ETSY_READINESS_STATE_ID` stay required so the payload validators still mean something — supply mock numerics in `.env`.
- New module `packages/shared/src/etsy-mock.ts`:
  - `isMockMode(): boolean` — reads cached settings.
  - `mockEtsyResponse(method, path, body?): unknown` — switch on `(METHOD, path)` and return canned JSON drawn from Etsy's own OpenAPI examples (per your "Recorded responses from Etsy docs" preference).
  - Path matchers tolerate the `${ETSY_SHOP_ID}` and `${listingId}` interpolation (regex on `/v3/application/shops/\d+/listings`, etc.).
  - Listing IDs are deterministic: `hash(title) % 1_000_000_000` so reruns produce the same `etsy_listing_id` (no DB orphans on rerun).
  - Logs `{ agent: "etsy-mock", method, path, fixture: <name> }` so the operator sees what's being faked.
- `etsyFetch` and `etsyMultipartFetch` in `etsy-api.ts` early-return the mock response (still through `limiter.schedule` so timing realism is preserved).
- `getValidAccessToken` in `etsy-auth.ts` early-returns `"mock-access-token"` and skips the rotating-token persistence.

Fixture catalog (`packages/shared/src/etsy-mock.ts` — co-located with the toggle so test code can import the same objects):

| (Method, path) | Source | Used by |
|---|---|---|
| `POST /public/oauth/token` | Etsy docs token sample | `etsy-auth.ts` |
| `GET /application/seller-taxonomy/nodes` | Etsy docs taxonomy tree (T-Shirts node included) | `etsy-taxonomy.ts` |
| `POST /application/shops/{id}/listings` | Etsy docs `createDraftListing` example | `createDraftListing` |
| `POST /application/shops/{id}/listings/{id}/images` | Etsy docs `uploadListingImage` example | `uploadListingImage` |
| `PUT /application/listings/{id}/inventory` | Etsy docs `updateListingInventory` example | new `updateListingInventory` |
| `PATCH /application/shops/{id}/listings/{id}` | Etsy docs `updateListing` example with `state: "active"` | `activateListing` |
| `GET /application/shops/{id}/receipts*` | Etsy docs `getShopReceipts` example | Ledger (no behavior change) |

Tests: refactor `publisher-flow.test.ts` so `baseHandlers()` reads from the same fixture map. Replace MSW with mock-mode toggle in a new `tests/integration/publisher-mock-mode.test.ts` that flips the flag and asserts the full flow lands at `active` without any MSW server. MSW remains for receipt + Printify tests.

### B. POD enrichment — variants, materials, image alt text

**B1. Variant inventory PUT**

Etsy's `PUT /v3/application/listings/{listing_id}/inventory` declares per-SKU price/quantity/sku and binds variations (sizes, colors). Today the listing only carries a flat `price`, which would publish a single non-variant listing and lose the S/M/L choice users expect.

- Add `updateListingInventory(db, listingId, products)` in `packages/shared/src/etsy-api.ts` with a Zod-validated input schema mirroring Etsy's `Inventory` shape (`products: [{ sku, offerings: [{ price, quantity, is_enabled }], property_values: [{ property_id, value_id, property_name, values }] }]`).
- New helper `packages/listing/src/inventory.ts` builds the products array from `design_packages.printify_variants` (already populated as `[{id, values: ["s","black"]}, …]` by `createHiddenProduct`). Maps Printify size/color labels to Etsy property IDs:
  - Property IDs are stable Etsy constants (`100` size, `200` color or similar — read from Etsy docs property catalog and bake as `ETSY_PROPERTY_IDS` in `packages/listing/src/constants.ts`).
  - `value_id` per size/color comes from a small static map (S/M/L/XL/2XL/3XL → numeric IDs from Etsy's standard size enum).
  - Per-variant `price` defaults to listing price; future-proof with optional per-variant override read from `BLUEPRINT_VARIANT_PRICE_USD` (already exists in `packages/listing/src/constants.ts`).
- Wire the call into `executeEtsyPublish` (`packages/listing/src/publisher.ts:262`): after `createDraftListing`, before `uploadListingImage`. Persist failure as a retryable error like the rest of the pipeline.
- Add Zod refinement on `EtsyListingCreateInputSchema` so `price` is treated as the *minimum* offering price (Etsy requires the top-level price to match the cheapest variant).

**B2. Materials field on draft listing**

- Pass `materials: ["cotton"]` from `createDraftListing` for blueprint 145. Constant in `packages/listing/src/constants.ts` keyed by blueprint ID (`BLUEPRINT_MATERIALS`). One line in `executeEtsyPublish`.

**B3. Image alt_text per upload**

- Extend `uploadListingImage(db, listingId, imageUrl, opts)` with `alt_text?: string` in the form body.
- Generate alt text from `copy.title` ("Front view of: <title>", "Back view of: <title>") in the publisher's image upload loop. Etsy caps at 250 chars.

**B4. processing_min / processing_max**

- Add `processing_min: 1, processing_max: 3` to the create payload (already optional in the schema). Captures Printify's typical 1-3 day production window. Constants per blueprint.

### C. Dashboard "Etsy payload preview" on listing approval

Pure read operation against the row that's already at `needs_review`. No new mutations.

- New helper `packages/listing/src/preview.ts`: given a `listings.id`, fetch the listing + joined design package, build the exact `EtsyListingCreateInput` and inventory `products` array using the same code paths the publisher will run. Return `{ create_listing: ..., inventory: ..., images: [...] }` as plain JSON.
- New API route in the dashboard: `GET /api/listings/[id]/etsy-preview` that calls the helper and returns the JSON.
- New collapsible panel on the listing review card (find the existing card under `apps/dashboard/` — likely in `app/(authed)/listings/` or similar) that fetches the preview and renders it in a `<pre>` block with a copy-to-clipboard button.
- The panel header explicitly states: "Mock mode: this is what would be POSTed when ETSY_MOCK_MODE=false." Tied to a small badge showing mock-mode status from `/api/health` (or a tiny new `/api/etsy-mode` endpoint).

## Files Touched

**New:**

- `packages/shared/src/etsy-mock.ts` — fixture catalog + dispatcher.
- `packages/listing/src/inventory.ts` — Printify variants → Etsy inventory `products`.
- `packages/listing/src/preview.ts` — assemble full Etsy payload for dashboard preview.
- `apps/dashboard/.../api/listings/[id]/etsy-preview/route.ts` — preview endpoint.
- `apps/dashboard/.../listings/.../EtsyPayloadPreview.tsx` — UI panel.
- `packages/listing/tests/integration/publisher-mock-mode.test.ts` — end-to-end run with `ETSY_MOCK_MODE=true`.
- `packages/listing/src/inventory.test.ts` — unit tests for the variant mapping.

**Modified:**

- `packages/shared/src/config.ts` — add `ETSY_MOCK_MODE`; loosen required Etsy creds when on.
- `packages/shared/src/etsy-api.ts` — short-circuit `etsyFetch` + `etsyMultipartFetch` in mock mode; add `updateListingInventory` + `EtsyInventoryInputSchema`; extend `uploadListingImage` with `alt_text`.
- `packages/shared/src/etsy-auth.ts` — short-circuit `getValidAccessToken` in mock mode.
- `packages/listing/src/publisher.ts` — call `updateListingInventory` after `createDraftListing` in `executeEtsyPublish`; pass `materials`, `processing_min`, `processing_max` on create; pass `alt_text` per image.
- `packages/listing/src/constants.ts` — `BLUEPRINT_MATERIALS`, `BLUEPRINT_PROCESSING_DAYS`, `ETSY_PROPERTY_IDS`, `ETSY_SIZE_VALUE_IDS`, `ETSY_COLOR_VALUE_IDS`.
- `.env.example` — document `ETSY_MOCK_MODE=true` and the placeholder values for the loosened-required keys.
- `CLAUDE.md` — short note on mock mode and the variant-inventory call (one paragraph in the Listing Agent section).
- `packages/listing/tests/integration/publisher-flow.test.ts` — refactor MSW handlers to import from `etsy-mock.ts` so fixtures live in one place.

## Reuses

- `etsyFetch` rate limiter, retry, and Zod validation pipeline — mock mode rides through it; production parity preserved.
- `getTaxonomyId` cache logic — mock fixture for `/seller-taxonomy/nodes` flows through unchanged.
- `EtsyListingCreateInputSchema` — extended, not replaced.
- `validateProductionPartnerId`, `validateMockupProvenance`, `validateCopyCompliance` — still run before the (now mock) Etsy POST.
- `design_packages.printify_variants` JSONB (migration 009) — already populated; we only consume it.
- MSW infrastructure in the existing integration test — kept for tests that *want* to assert HTTP-level behavior; mock-mode lives alongside, not as a replacement.

## Non-Goals

- No real Etsy publishing. The flag stays default-false; nothing changes about live behavior.
- No multi-blueprint expansion (still Gildan 64000 only). Adding a second blueprint stays one constant-table edit.
- No retries against rate-limit `429` exhaustion mid-day quota — separate work.
- No webhook/inventory-sync work — also separate.

## Verification

1. **Unit tests:** `npm test --workspace=packages/listing` — `inventory.test.ts` covers variant mapping; existing `compliance.test.ts`, `publisher.test.ts`, `printify.test.ts`, `copywriter.test.ts` continue to pass with no MSW changes since the mock module isolates fixtures.
2. **Refactored integration:** `INTEGRATION=1 npm test --workspace=packages/listing tests/integration/publisher-flow.test.ts` — must pass after MSW handlers are sourced from `etsy-mock.ts`.
3. **Mock-mode integration (new):** `INTEGRATION=1 ETSY_MOCK_MODE=true npm test --workspace=packages/listing tests/integration/publisher-mock-mode.test.ts` — runs the same scenario without MSW. Asserts:
   - Listing reaches `status='active'`, `is_active=true`, `etsy_listing_id` populated.
   - `design_packages.mockups_from_actual_design=true`.
   - The `etsy-mock` log line fired for create + inventory + image upload + activate.
4. **End-to-end smoke against cloud Supabase** (per memory: cloud only, never local):
   - Confirm at least one `design_packages` row sits at `status='approved'` in the cloud project; if not, approve one via the dashboard.
   - `ETSY_MOCK_MODE=true npx ts-node packages/listing/src/index.ts` — should claim, create the Printify product (real), pause at `needs_review`.
   - Approve in dashboard → row flips to `pending_publish`.
   - Re-run the listing index → `executeEtsyPublish` runs entirely against fixtures and the row lands at `active`.
   - Cleanup: set the row back to `pending_publish` or delete the test listing row before flipping mock mode off.
5. **Dashboard preview:** load the listing review card for a `needs_review` row → "Etsy payload preview" panel renders a JSON block containing `who_made: "i_did"`, `production_partner_ids: [...]`, `materials: ["cotton"]`, and the inventory products array with all variant prices.
6. **Flip-the-switch confirmation:** with mock mode off and intentionally broken Etsy creds, the same path 401s on the first `etsyFetch`. With mock mode on, succeeds. That's the contract.

## Out-of-band Note

After plan approval (per the user's standing preference for plan-as-repo-artifact), mirror this file to `PLAN_listing_etsy_mock_mode.md` at the repo root before starting execution.
