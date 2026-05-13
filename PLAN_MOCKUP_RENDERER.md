# Plan: Custom Mockup Renderer in Listing Agent

## Context

Etsy's algorithm weighs the first listing image heavily — CTR drives ranking, the hero image drives CTR. Today the Listing agent uses whatever Printify auto-generates: ~6 stock mockup templates (front studio, back studio, flat-lay, model shot) that every other Printify-based POD seller uses. Experienced Etsy buyers recognize them on sight as "drop-shipped POD shop" and skip past. With $11.99 competitors flooding niches we want to win on quality, not price; better mockups are the single highest-leverage CTR lever short of niche selection itself.

This plan inserts a custom mockup-rendering step in `packages/listing/src/publisher.ts` between Printify product creation and Etsy image upload. We composite the same design PNG that Printify will print onto a richer set of lifestyle / detail / alternate-scene mockups via Dynamic Mockups API, host the results in Supabase Storage, and put them ahead of Printify's mockups in the listing image array. Same product fulfillment; dramatically better first impression.

Decisions locked with user:
1. **Service: Dynamic Mockups API** (`dynamicmockups.com`) — REST API, POD-tailored templates, $14/mo (250 renders) or $29/mo (1500). Not Placeit — Placeit's API is partner-only.
2. **Mockup count: 3 custom + 2 Printify supplement.** Final Etsy listing has 5 images: hero lifestyle, detail close-up, alternate scene (all custom-rendered), then Printify's front studio and flat-lay shots.
3. **Soft fail.** If Dynamic Mockups errors or the renderer fails, fall through to Printify mockups only and post a Slack `severity="warn"`. Listing still publishes. Mirrors the upscaler step's failure mode.

---

## Pipeline (before → after)

Before, in `packages/listing/src/publisher.ts:139-162`:
```
createHiddenProduct() → { productId, mockupUrls: [printify1..printifyN] }
  ↓
db.update design_packages SET mockup_urls = mockupUrls, mockups_from_actual_design = true
  ↓
[Etsy publish branch] for url of mockupUrls: uploadListingImage(db, etsyId, url)
```

After:
```
createHiddenProduct() → { productId, mockupUrls: [printify1..printifyN] }
  ↓
renderCustomMockups(design.image_url, design.id)         ← NEW
  ↓ (3 renders via Dynamic Mockups, hosted in Supabase Storage)
combinedMockupUrls = [...customUrls, printify1, printify2]   ← 5 total, custom first
  ↓
db.update design_packages SET mockup_urls = combinedMockupUrls, mockups_from_actual_design = true
  ↓
[Etsy publish branch] for url of combinedMockupUrls: uploadListingImage(db, etsyId, url)
```

Soft-fail short-circuit: if `renderCustomMockups()` throws, set `combinedMockupUrls = mockupUrls` (Printify only), log warning, post Slack. Everything downstream stays identical.

`validateMockupProvenance()` (`packages/listing/src/compliance.ts:90`) checks the boolean flag only — it doesn't inspect URLs. Since our custom mockups are composited from the same `design.image_url` Printify uses, the flag remains `true` and the gate passes. Document this in a code comment on the flag set call.

---

## File Changes

### NEW: `packages/shared/src/dynamic-mockups-http.ts`

Rate-limited HTTP client, mirrors `packages/shared/src/printify-http.ts`:
- Single `Bottleneck` instance (`maxConcurrent: 2, minTime: 250` — conservative since we only render 3 mockups per design and the API has no published global limit).
- Headers: `Content-Type: application/json`, `Authorization: Bearer ${DYNAMIC_MOCKUPS_API_KEY}`, `User-Agent: presswork/<version>` (match Printify client convention).
- Retry: 3 attempts, exponential backoff on 5xx, parse `Retry-After` on 429, bail fast on 4xx (mirrors `etsyFetch` lines 19–80).
- Export: `async function dynamicMockupsFetch(path: string, init?: RequestInit): Promise<unknown>`.
- No webhooks, no error-rate guard (not enough call volume to justify the ring buffer Printify uses).

### NEW: `packages/listing/src/mockup-templates.ts`

Hard-coded template IDs for v1. Niche-aware selection is out of scope:
```ts
// Dynamic Mockups template IDs for blueprint 145 (Gildan 64000 Unisex Softstyle).
// Selected manually from the Dynamic Mockups template library to give CTR-optimized
// variety: one lifestyle hero, one detail close-up, one alternate scene.
// To swap templates: log into dynamicmockups.com, copy the template UUID from the
// template URL, and update the value here.
export const TEMPLATE_HERO_LIFESTYLE = "<uuid-to-fill>";
export const TEMPLATE_DETAIL_CLOSEUP = "<uuid-to-fill>";
export const TEMPLATE_ALTERNATE_SCENE = "<uuid-to-fill>";

export const MOCKUP_TEMPLATES = [
  TEMPLATE_HERO_LIFESTYLE,
  TEMPLATE_DETAIL_CLOSEUP,
  TEMPLATE_ALTERNATE_SCENE,
] as const;
```

Implementation pulls actual UUIDs during impl by browsing Dynamic Mockups' library — this is a manual sourcing step, not a code change.

### NEW: `packages/listing/src/mockup-renderer.ts`

Main module. Public surface:
```ts
export async function renderCustomMockups(
  designImageUrl: string,
  designId: string,
  db: Db
): Promise<string[]>
```

Internal flow:
1. For each template in `MOCKUP_TEMPLATES`, call `dynamicMockupsFetch("/v1/renders", { method: "POST", body: { template_uuid, design_image_url: designImageUrl, ... } })`.
2. Dynamic Mockups returns a rendered image URL (possibly synchronous, possibly polling — confirm at impl time; their docs may require `GET /v1/renders/:id` poll).
3. Download the rendered image bytes (use the URL-download pattern in `etsy-api.ts:256-324`).
4. Upload to Supabase Storage bucket `mockups` at path `${designId}/${templateUuid}.jpg`:
   ```ts
   await db.storage.from("mockups").upload(
     `${designId}/${templateUuid}.jpg`,
     blob,
     { contentType: "image/jpeg", upsert: true }
   );
   const { data } = db.storage.from("mockups").getPublicUrl(`${designId}/${templateUuid}.jpg`);
   ```
5. Return array of 3 Supabase public URLs in template order (hero first).

Why re-host in Supabase Storage instead of passing Dynamic Mockups URLs to Etsy:
- Dynamic Mockups URLs may be signed / time-limited / cache-evicted; our control of the URL lifecycle is the only thing that guarantees Etsy can still pull the image weeks later if it ever re-fetches.
- Pattern consistency with how design PNGs already flow through `packages/design/storage.py`.
- Auditability — we know exactly what bytes Etsy received.

Render the 3 mockups in parallel via `Promise.all`. They're independent.

### NEW: Supabase Storage bucket `mockups`

Must be created in Supabase Dashboard or via migration before first run. Public read access, service-role write. Note in plan: this is an operator step, not code.

### MODIFIED: `packages/listing/src/publisher.ts`

Two insertions:

**(a)** After line 152 (the `result = await createHiddenProduct(...)` and before the `db.update`):
```ts
let customMockupUrls: string[] = [];
if (settings.MOCKUP_RENDERER_ENABLED) {
  try {
    customMockupUrls = await renderCustomMockups(
      design.image_url ?? "",
      design.id,
      db
    );
  } catch (renderErr) {
    log.warn({
      msg: "mockup_renderer_failed_fallback",
      design_id: design.id,
      err: String(renderErr),
    });
    await notifySlack(
      `Mockup renderer failed for design ${design.id}, using Printify mockups only: ${renderErr}`,
      "warn"
    );
  }
}

// Custom mockups first (hero on Etsy = first image), then 2 Printify shots.
// mockups_from_actual_design stays true: both sets composite from design.image_url.
const combinedMockupUrls = [
  ...customMockupUrls,
  ...mockupUrls.slice(0, 2),
];
```

**(b)** Replace existing `mockupUrls` references downstream (the `db.update` and the `for (const url of mockupUrls)` Etsy upload loop) with `combinedMockupUrls`.

### MODIFIED: `packages/shared/src/config.ts`

Add to the Zod `SettingsSchema`:
```ts
DYNAMIC_MOCKUPS_API_KEY: z.string().min(1).optional(),
MOCKUP_RENDERER_ENABLED: z.coerce.boolean().default(false),
```

`MOCKUP_RENDERER_ENABLED` defaults to **false** — operator opt-in. API key is optional so dev environments without a key can still run.

Validation: if `MOCKUP_RENDERER_ENABLED=true` but `DYNAMIC_MOCKUPS_API_KEY` is missing, fail fast at boot. Add a refinement:
```ts
.refine(
  (s) => !s.MOCKUP_RENDERER_ENABLED || !!s.DYNAMIC_MOCKUPS_API_KEY,
  { message: "DYNAMIC_MOCKUPS_API_KEY is required when MOCKUP_RENDERER_ENABLED=true" }
)
```

### MODIFIED: `.env.example`

Append:
```
# Dynamic Mockups (https://dynamicmockups.com) — optional custom mockup renderer
# for Etsy listing images. Falls back to Printify mockups if disabled or errors.
DYNAMIC_MOCKUPS_API_KEY=
MOCKUP_RENDERER_ENABLED=false
```

### MODIFIED: `CLAUDE.md`

Under "Agent 3 — Listing", insert between current steps 6 (Printify product creation) and 7 (human review pause): the custom-mockup render step and its soft-fail behavior. Skip until after rollout verification — same convention as the upscaler.

---

## Critical Files

| Path | Reason |
|---|---|
| `packages/listing/src/publisher.ts:139-162` | Insertion point for renderer call + combined URL array |
| `packages/listing/src/mockup-renderer.ts` | NEW — main module |
| `packages/listing/src/mockup-templates.ts` | NEW — template UUID constants |
| `packages/shared/src/dynamic-mockups-http.ts` | NEW — rate-limited HTTP client |
| `packages/shared/src/config.ts` | Add 2 env vars + refinement |
| `packages/shared/src/printify-http.ts` | Reference pattern for the new HTTP client — do not modify |
| `packages/shared/src/etsy-api.ts:242-325` | Reference for blob-download pattern |
| `packages/listing/src/compliance.ts:90` | `validateMockupProvenance` — unchanged, but verify flag stays true |
| `.env.example` | New env vars |

---

## Tests

Existing TS tests use Vitest. Mock HTTP at the `fetch` boundary or via `vi.mock`.

### NEW: `packages/shared/src/dynamic-mockups-http.test.ts`

Mirror the shape of any existing HTTP-client test (check `printify-http.test.ts` first):
- 5xx retries 3 times then throws.
- 4xx fails immediately, no retry.
- 429 with `Retry-After` waits, then retries.
- Authorization header includes the bearer token from settings.

### NEW: `packages/listing/src/mockup-renderer.test.ts`

- Happy path: 3 templates → 3 renders, 3 Supabase uploads, returns 3 public URLs in template order. Use `vi.mock` for `dynamicMockupsFetch` and Supabase storage.
- One template fails: full call rejects (the soft-fail wrapper is in `publisher.ts`, not the renderer itself, so partial success is not a renderer concern).
- Parallel renders: assert `Promise.all` pattern by verifying all 3 `dynamicMockupsFetch` calls fired before any resolves (timing assertion).

### MODIFIED: `packages/listing/src/publisher.test.ts`

- Add to existing test setup: mock `renderCustomMockups` to return 3 fake URLs by default.
- New test `mockup_renderer_disabled_uses_printify_only` — `MOCKUP_RENDERER_ENABLED=false` → `combinedMockupUrls` equals only the Printify subset, renderer not called.
- New test `mockup_renderer_failure_falls_back_to_printify` — `renderCustomMockups` throws → listing still publishes with Printify URLs only, `notifySlack` called with `severity="warn"`, `mockups_from_actual_design=true` still set.
- New test `combined_mockup_array_order` — assert custom URLs come first (Etsy uses image 0 as the search thumbnail).
- Existing tests that assert `mockup_urls` length: update expectations to 5 (3 custom + 2 Printify) when renderer enabled.

Run:
```bash
npm test --workspace=packages/listing
npm test --workspace=packages/shared
```

---

## Verification (end-to-end)

1. **Unit tests pass**: `npm test --workspaces` — all new + modified tests green.
2. **Source the 3 template UUIDs** from dynamicmockups.com manually before first run; update `mockup-templates.ts`. Pick: one lifestyle "person wearing tee outdoors", one detail close-up, one flat-lay-with-props alternate scene.
3. **Create Supabase Storage bucket `mockups`** via Supabase Dashboard with public read access.
4. **Local smoke run against cloud Supabase** (per project rule: never local Supabase):
   - Run the Design agent end-to-end on one trend brief so a `design_packages` row reaches `status='done'`.
   - With `MOCKUP_RENDERER_ENABLED=true` and `DYNAMIC_MOCKUPS_API_KEY` set in `.env`, run `cd packages/listing && npx ts-node src/index.ts`.
   - Confirm: `design_packages.mockup_urls` contains 5 URLs (3 from `<supabase-url>/storage/v1/object/public/mockups/...`, 2 from `cdn.printify.com/...`), the first 3 visibly look like lifestyle/detail/alternate mockups, and `mockups_from_actual_design=true`.
   - Check Etsy draft listing in Shop Manager: confirm 5 images uploaded, custom mockups first.
5. **Soft-fail path**: set `DYNAMIC_MOCKUPS_API_KEY=invalid` (or temporarily block egress), run again. Confirm listing still reaches `status='active'` with 5 (or fewer if Printify provides <2) Printify-only URLs in `mockup_urls`, and a Slack `warn` message arrives.
6. **CTR sanity check** post-launch: pick 5 niches, publish one listing per niche with renderer ON and one OFF (same prompt, same design). After 2 weeks, compare impressions vs visits in Etsy Stats. We expect 1.5–3× CTR uplift on the renderer-ON variants. This validates the spend.
7. **Update `CLAUDE.md`** Listing agent spec to include the render step (only after step 6 confirms the lift).

---

## Out of Scope

- **Niche-aware template selection.** v1 hard-codes 3 generic templates. Mapping `trend_briefs.niche` to template selection (e.g., outdoor niches → hiking lifestyle template, kitchen niches → cafe scene) is a follow-up once we have data on which templates convert best.
- **Variant-specific mockups** (black tee vs white tee vs gray tee). Dynamic Mockups supports color overrides, but Printify's color variant photos handle this acceptably. Revisit if buyers report confusion.
- **AI-generated mockups via FLUX.** Cheaper per-render but unreliable for "this is what you'll receive" use; better as supplementary atmospheric imagery once we have the bandwidth.
- **A/B framework for template choice.** Manual eyeball comparison in step 6 above is sufficient signal at our scale.
- **Migrating away from Printify mockups entirely** (5 custom, 0 Printify). Keep at least 2 Printify shots for garment-detail credibility.

---

## Cost & Volume Notes

- $14/mo Dynamic Mockups plan = 250 renders/month = ~83 designs at 3 renders each.
- $29/mo plan = 1500 renders = ~500 designs.
- Current Design agent volume is ~5–10 designs/day per the cron schedule, so $14/mo covers the foreseeable runway. Bump to $29 only after sustained volume above 80 designs/month.
- Per-design marginal cost: $0.17–0.06 depending on plan tier. Negligible against the $24.99 sticker price; an even modest CTR lift pays for the entire subscription in extra sales per week.

---

## Rollout

1. Land all code changes behind `MOCKUP_RENDERER_ENABLED=false` default. Merge to main with the feature dark.
2. Source the 3 template UUIDs; update `mockup-templates.ts`; commit.
3. Create the `mockups` Supabase Storage bucket in cloud Supabase.
4. Set `DYNAMIC_MOCKUPS_API_KEY` and `MOCKUP_RENDERER_ENABLED=false` in Railway env group (key present, flag still off).
5. Run one manual smoke test from local against cloud (Verification step 4). Eyeball results.
6. Flip `MOCKUP_RENDERER_ENABLED=true` in Railway.
7. Watch Slack for `mockup_renderer_failed_fallback` warnings over first 48 hours.
8. After 2 weeks, run the A/B comparison (Verification step 6); if no lift, revert the flag and revisit template selection before retrying.
