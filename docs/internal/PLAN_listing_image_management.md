# Plan — Listing Image Management (pre-publish selection + active-listing editing)

_Status: proposed — awaiting approval before any code changes. Plan approval ≠ execution approval._

## Goal (owner)
1. **Pre-publish:** choose which images actually go up with a listing before publishing (instead of uploading every mockup).
2. **Post-publish:** on an active listing, see which images are live, delete any, and add new ones.

## Decisions locked in
- Selection storage: **ephemeral (no migration)** — chosen subset is carried through the synchronous publish call.
- Active-edit scope: **add + delete only** (no reorder).
- Image pool: **mockups only** (raw design PNG stays internal).

---

## What already exists (verified in code)

**Requirement #2 (post-publish editing) is already built:**
- `packages/dashboard/components/listings/EtsyImagePanel.tsx` — view live Etsy images, delete, and add from the mockup pool. Rendered on the detail page (`page.tsx:101-108`) for `status==='active'` with `etsy_listing_id`, receiving `designImageUrl` + `mockupUrls` props.
- `packages/dashboard/app/api/listings/[id]/etsy-images/route.ts` — `GET` (list) / `POST` (upload, SSRF host allowlist + server-side rank default at line 137) / `DELETE`, each gated by `requireOwnerEmail()`.
- `packages/shared/src/etsy-api.ts` — `getListingImages` (432), `uploadListingImage` (288), `deleteListingImage` (447), `getListingImageCount` (420), all behind the shared Bottleneck limiter + 429 retry.
- `packages/shared/src/etsy-mock.ts` — `list_listing_images`, `upload_listing_image`, `delete_listing_image` fixtures (mock mode works end-to-end).

**Synchronous publish-from-dashboard already exists:**
- `publishListingNow` server action — `packages/dashboard/lib/actions/listings.ts:809` (owner + `pending_publish` guard; calls `resumePublish(db, id)`).
- `PublishNowCard` — inline component in `packages/dashboard/app/listings/[id]/page.tsx:358-405` (a `<details>` "Publish now…" popover with the $0.20 fee warning, posting `{ id }` to `publishListingNow`).
- `@presswork/listing` is already a dashboard dependency (`package.json:19`) and built via `build:deps`; `resumePublish` (`publisher.ts:428`) is imported via the `@presswork/listing/publish` subpath. **No code relocation needed.**

**The one true gap:** there is **no image-selection** anywhere. The publish path uploads **every** `design_packages.mockup_urls` entry in order (`publisher.ts:389-396`), and `publishListingNow` / `PublishNowCard` have no per-image picker.

Etsy constraints confirmed: images are mutable on draft/active/inactive listings; **max 10 images**; `POST` is not idempotent (`getListingImageCount` is the existing dedup guard).

---

## Part 1 — Thread an optional image selection through the publish path (net-new, core)

Backward-compatible: no selection ⇒ identical to today (upload all).

1. `publisher.ts` — add `opts?: { selectedMockupUrls?: string[] }` to `resumePublish` (428), threaded into the private `executeEtsyPublish` (300).
2. In `executeEtsyPublish`, before the upload loop (389-396): if `selectedMockupUrls` is provided, filter `mockupUrls` to that subset **in the operator's order**; silently drop any URL not in the row's `mockup_urls` (defense-in-depth). Undefined/empty ⇒ full list (current behavior).
3. Keep the `getListingImageCount` idempotency guard; the loop uploads `selected[alreadyUploaded..]`. Enforce the **10-image cap** (throw a clear `PublisherError` before any Etsy call if selection > 10).
4. Compliance gates (`validateMockupProvenance`, copy checks at 315-317) run unchanged — selection only narrows which mockups upload.

**Tests (Vitest + MSW, in `publisher.test.ts`):**
- Selection subset ⇒ only those URLs `POST …/images`, in selection order.
- No selection ⇒ all mockups upload (regression).
- Selection containing a URL not in `mockup_urls` ⇒ ignored.
- >10 selected ⇒ rejected before any Etsy call.

---

## Part 2 — Pre-publish selection UI (net-new)

`publishListingNow` (`listings.ts:809`) and the inline `PublishNowCard` (`page.tsx:358`) already drive synchronous publish; they just need the selection added.

1. `publishListingNow` — read `formData.getAll("selectedImageUrls")`, validate with Zod (`z.string().url().array()`), pass as `resumePublish(db, id, { selectedMockupUrls })`. Keep the existing owner + status guard + revalidate.
2. `PublishNowCard` (inline in `page.tsx:358`) — pass `mockupUrls` down from the page (already available as `listing.design_packages?.mockup_urls`; today the card only receives `listingId` + `isAgentRunning`). Inside the `<details>` form, render a **checkbox grid over the mockup pool**, each `<input type="checkbox" name="selectedImageUrls" value={url} defaultChecked>` with the existing thumbnail styling. Plain HTML checkboxes submit the checked set with **no client JS** — the card stays a server component.
3. Optional progressive enhancement: a small `"use client"` wrapper for a live "N of M selected" count and disabling submit at 0 or >10. The Zod + `PublisherError` checks remain the source of truth either way.

**Tests:** extend `listings.test.ts` — `publishListingNow` asserts owner + status guard + forwards the parsed selection to a mocked `resumePublish`.

---

## Part 3 — Polish the existing active-listing editor (small)

Verify-then-fix on `components/listings/EtsyImagePanel.tsx` (some may already be present):
- Disable **Add to Etsy** once 10 images are live, with a hint.
- Add a confirm step before **Delete** (reuse `<details>` popover) — it mutates a live listing.
- Show each live image's `rank` so carousel order is visible.

---

## Out of scope (v1)
- Reorder of live images (no Etsy endpoint ⇒ delete+repost; deferred).
- Uploading the raw design PNG (mockups-only by decision).
- Persisting the selection across reloads (ephemeral by decision; a reload re-defaults to all-checked).

## Known v1 caveat (conscious choice)
Ephemeral selection lives only in the dashboard's synchronous publish call. If that publish partially fails and the **listing agent** later resumes the same `pending_publish` row, the agent path has no selection and uploads the full mockup list. Acceptable for v1 (mock-mode testing + 10-cap). The clean fix is a persisted `listings.selected_image_urls TEXT[]` column (next migration would be `053_…`) — the migration you opted out of; easy to add later if the ephemeral behavior bites.

## Execution order
1. Part 1 (publish-path filter + tests) — safe, backward-compatible, shippable alone.
2. Part 2 (selection UI + action wiring).
3. Part 3 (editor polish).

Per repo convention: tests alongside each part; `ETSY_MOCK_MODE=true` for full-flow checks; commit + push directly to `main`.
