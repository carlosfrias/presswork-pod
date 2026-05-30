# Dashboard History Views + Active-Listing Edit / Republish

## Context

The dashboard's per-agent pages currently bucket recent rows under "Recent X" with small limits (Scout 8, Design 24, Listings 20). For visibility into the pipeline you want each of those to be the *full* history list (paginated later), and a couple of agent-specific UX changes:

- **Scout / Design / Listings**: rename "Recent X" → "All X", lift the limit so the full history is visible (capped high enough not to nuke the dashboard, paginate properly later).
- **Builder**: each "From Scout" brief card is currently always-expanded with a textarea, build button, and editable description. Make the cards collapsible so the queue is scannable. Don't introduce any new persisted state on the builder side — the only existing write is the `image_description` column on the new child brief that `sendToDesign()` creates, which is correct (the prompt is recoverable from there or from `design_packages.fal_prompt` after Design runs).
- **Listings (the meaty piece)**: today the `CopyEditor` is gated to `status='needs_review'`. You want to drill into an `active` listing, edit its copy, and republish. Etsy v3 supports this in-place via the same `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}` endpoint we already use for activation — same path, body without `state` updates the metadata. Edits go live immediately; no re-approval delay. The existing mock fixture in `etsy-mock.ts` already handles this case (it defaults `state` to "active" if the body omits it), so mock-mode dry-runs work without any fixture work.

You chose: **edit scope = title / description / tags only** (matches what `CopyEditor` already does), and **two-step push** (Save → DB; separate "Push to Etsy" button → API call). That gives you a stage-and-review workflow without surprising the operator with an instant-live Etsy mutation.

## Approach

### A. History views (Scout, Design, Listings)

Three near-identical changes:

- **`packages/dashboard/app/scout/page.tsx`**: rename the "Recent briefs" SurfaceCard title to "All briefs"; bump `getRecentBriefs(8)` → `getAllBriefs(500)` (new query name to make intent obvious).
- **`packages/dashboard/lib/queries/scout.ts`**: add `getAllBriefs(limit = 500)`. Keeps the existing `getRecentBriefs` for back-compat or remove it if no other caller — confirm via grep.
- **`packages/dashboard/app/design/page.tsx`**: rename "Recent designs" → "All designs"; `getRecentDesigns(24)` → `getAllDesigns(500)`.
- **`packages/dashboard/lib/queries/design.ts`**: add `getAllDesigns(limit = 500)`.
- **`packages/dashboard/app/listings/page.tsx`**: rename "Recent listings" → "All listings"; `getRecentListings(20)` → `getAllListings(500)`.
- **`packages/dashboard/lib/queries/listings.ts`**: add `getAllListings(limit = 500)`.

Cap is 500 each — high enough to feel like "all" for current scale, low enough that one page render doesn't fetch an arbitrary number of joined rows. Pagination becomes a separate task once any of these crosses ~300 rows in practice.

### B. Builder collapsible cards

- **`packages/dashboard/components/builder/FromScoutCard.tsx`**: add a local `isExpanded` state (default `false`). Render a compact summary row when collapsed (niche · style keywords · created_at · "expand →"), and the full builder UI when expanded.
- The card is already a `"use client"` component with local state for seed / style / imageModel / description (lines 35–54). Collapsing/expanding loses none of those — they're just hidden from the DOM. No persistence change needed; the only DB write (`sendToDesign()` → `image_description` on a new child brief) stays as-is.
- One small UX touch: pre-expand any card the operator has actively been editing (e.g., when `description` or `seed` is non-empty). Avoids a foot-gun where they collapse-by-mistake and lose unsaved edits — but per the contract, that loss is acceptable since nothing's persisted yet.

### C. Active-listing edit + push to Etsy

**Shared API** (`packages/shared/src/etsy-api.ts`):

- Add `EtsyListingUpdateInputSchema` — Zod for the editable subset (`title?`, `description?`, `tags?`). Top-level optional fields so a partial PATCH is well-formed.
- Add `updateActiveListing(db, listingId, updates)` — wraps `etsyFetch(db, '/application/shops/{ETSY_SHOP_ID}/listings/{listingId}', { method: 'PATCH', body: JSON.stringify(validated) })`. Same shape as `activateListing`, just no `state` field.
- Mock: `etsy-mock.ts` already matches `PATCH /application/shops/{shop_id}/listings/{id}` and tolerates missing `state` (line ~245 — defaults to "active"). No fixture changes.

**Dashboard server action** (`packages/dashboard/lib/actions/listings.ts`):

- New action `updateActiveListingCopy(formData)`:
  - Asserts owner.
  - Confirms `listing.status === 'active'`.
  - Same `ListingCopySchema.safeParse` + `validateCopyCompliance` gates as the existing `updateListingCopy`.
  - Writes `title / description / tags` to the listings row only. Does NOT call Etsy.
  - revalidates `/listings` and `/listings/{id}`.
- New action `pushListingToEtsy(formData)`:
  - Asserts owner.
  - Confirms `listing.status === 'active'` and `listing.etsy_listing_id` is non-null.
  - Re-runs `validateCopyCompliance` on the current row (defense-in-depth — the Save action ran the gates, but config or constants could have shifted between Save and Push).
  - Calls `updateActiveListing(db, listing.etsy_listing_id, { title, description, tags })`.
  - On success, sets `listings.last_pushed_at = now()` (new column) so the UI can show "last pushed at X". On failure, writes `error_message` and surfaces in the existing error UI.
  - revalidates the same two paths.

**Schema migration** (`infra/supabase/migrations/047_listings_last_pushed_at.sql`):

```sql
ALTER TABLE listings ADD COLUMN last_pushed_at TIMESTAMPTZ;
COMMENT ON COLUMN listings.last_pushed_at IS
  'When the operator last pushed local copy edits to Etsy via PATCH. NULL until the first push. Used by the dashboard to indicate unpushed changes (updated_at > last_pushed_at).';
-- Backfill: any listing currently active was last pushed at its updated_at.
UPDATE listings SET last_pushed_at = updated_at WHERE status = 'active';
```

**CopyEditor + detail page** (`packages/dashboard/components/listings/CopyEditor.tsx`, `packages/dashboard/app/listings/[id]/page.tsx`):

- Extend `CopyEditor` with an `editableForActive` mode. When the listing is `active`:
  - Render the same form fields, same compliance live-counters.
  - Form `action` points to `updateActiveListingCopy` instead of `updateListingCopy`.
  - Show a small banner above the form: "This is a live Etsy listing. Save updates the dashboard only. Click Push to Etsy below to apply changes to the live listing."
- On the detail page Copy card:
  - `status === 'needs_review'` → existing CopyEditor flow (unchanged).
  - `status === 'active'` → CopyEditor in `editableForActive` mode.
  - Other statuses → existing read-only fallback.
- Below the editor on `active` listings, render a **Push to Etsy** form (small `<form action={pushListingToEtsy}>`):
  - Disabled when `listings.updated_at <= listings.last_pushed_at` (no unpushed changes), with helper text "All changes pushed".
  - Enabled with text "Push X edits to Etsy" when there are unpushed changes; subtitle shows `last_pushed_at` relative time.
  - Uses `SubmitButton` for pending state.

## Files Touched

**New**

- `infra/supabase/migrations/047_listings_last_pushed_at.sql` — column + backfill.

**Modified**

- `packages/shared/src/etsy-api.ts` — `EtsyListingUpdateInputSchema` + `updateActiveListing()`.
- `packages/dashboard/lib/actions/listings.ts` — `updateActiveListingCopy()` + `pushListingToEtsy()`.
- `packages/dashboard/lib/queries/scout.ts` — `getAllBriefs()`.
- `packages/dashboard/lib/queries/design.ts` — `getAllDesigns()`.
- `packages/dashboard/lib/queries/listings.ts` — `getAllListings()`. Also extend the listings select to include `last_pushed_at` (or fetch on the detail page query directly).
- `packages/dashboard/app/scout/page.tsx` — rename "Recent briefs" → "All briefs"; switch query.
- `packages/dashboard/app/design/page.tsx` — rename "Recent designs" → "All designs"; switch query.
- `packages/dashboard/app/listings/page.tsx` — rename "Recent listings" → "All listings"; switch query.
- `packages/dashboard/components/builder/FromScoutCard.tsx` — collapsible state + summary row.
- `packages/dashboard/components/listings/CopyEditor.tsx` — `editableForActive` mode, banner, action target.
- `packages/dashboard/app/listings/[id]/page.tsx` — render editor for `active`; render Push to Etsy form.

## Reuses

- `etsyFetch` rate limiter + retry pipeline — `updateActiveListing` is a one-line wrapper on the same shared client.
- `etsy-mock.ts` `update_listing_state` fixture — already covers PATCH without state, no fixture change.
- `validateCopyCompliance` and `ListingCopySchema` from `@presswork/shared` — same gates run on edits as on initial publish, so an active-listing edit can't smuggle in a forbidden term.
- `SubmitButton` from `@/components/ui/SubmitButton` — pending state for both Save and Push.
- `formatRelative` from `@/lib/format` — for the "Last pushed at X ago" helper text.
- `assertOwner()` pattern in `lib/actions/listings.ts` — both new actions use the same auth check.

## Non-Goals

- No price / inventory / image edits in this slice. Adding price means an extra `PUT /inventory` call alongside the PATCH; intentionally deferred.
- No pagination UI on Scout / Design / Listings — limits bumped to 500, that's it. Pagination is a separate task once a list crosses ~300 rows in practice.
- No diff view on the Push button. v1 just shows "X edits to Etsy" or "All changes pushed". Field-by-field diff is a follow-up.
- No "Pull from Etsy" sync if the listing was edited outside the dashboard. Out of scope; we treat the dashboard as the source of truth for our own edits.

## Verification

1. **Migration applied**: `mcp__plugin_supabase_supabase__apply_migration` with the `047_listings_last_pushed_at.sql` body. Verify with `SELECT column_name FROM information_schema.columns WHERE table_name='listings' AND column_name='last_pushed_at';`.
2. **History views**: navigate to `/scout`, `/design`, `/listings`. Each section header reads "All X". The list shows more than the previous limit (8 / 24 / 20) up to whatever's in the DB.
3. **Builder collapsible**: each "From Scout" card on `/builder` renders a compact summary by default. Clicking expands to the existing build UI. Collapsing and re-expanding does not lose state mid-session for the same render (state lives on the component; collapse just hides). Reloading the page resets to collapsed (intentional — no persistence).
4. **Active edit happy path** (mock mode):
   - Pick an `active` listing. Open `/listings/{id}`.
   - The Copy card shows the editor + the warning banner. Push button is disabled with "All changes pushed".
   - Edit the title. Save. The DB row updates. Push button becomes enabled with "Push 1 edits to Etsy" (subtitle: prior push timestamp).
   - Click Push. With `ETSY_MOCK_MODE=true` the etsy-mock dispatcher logs a `PATCH /listings/{id}` hit. `last_pushed_at` updates. Push button returns to disabled.
5. **Active edit compliance gate**: enter a title containing "unique" → Save throws with `"Etsy POD policy violation — forbidden term(s): unique"`. The DB row is unchanged.
6. **Push without unpushed changes**: button disabled (no-op).
7. **Tests**:
   - Unit: extend `lib/actions/listings.test.ts` to cover `updateActiveListingCopy` (status guard + compliance) and `pushListingToEtsy` (status guard + last_pushed_at write).
   - Typecheck: `npm run typecheck --workspaces --if-present`.
   - Listing tests: `npm test --workspace=packages/listing` should be untouched (nothing here changes the publisher path).

## Out-of-band Note

After plan approval, mirror this file to `PLAN_dashboard_history_and_active_edit.md` at the repo root (per the standing artifact preference). The previous plan's repo-root mirror (`PLAN_listing_etsy_mock_mode.md`) stays in place since that work shipped.
