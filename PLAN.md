# Plan: End-to-end Scout → Design quality validation (no Etsy listing)

## Goal

Run the existing Scout and Design agents against real upstream APIs, produce
real print-ready PNGs, and visually inspect them to decide whether the design
quality is good enough to justify continuing with Listing/Fulfillment work.

Out of scope: Listing agent (Etsy publish), Fulfillment agent, Printify
product creation. Etsy is read-only here (Scout only).

## Why this is possible without mocking

`.env` already has every credential we need:

| Used by | Var | Status |
|---|---|---|
| Scout | `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN` | set |
| Scout + Design (Claude) | `ANTHROPIC_API_KEY` | set |
| Design (image gen) | `FAL_KEY` | set |
| Both (handoff) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | set |

OAuth tokens expire hourly; `etsy_client.py:30` already refreshes on 401, so a
stale access token is self-healing as long as the refresh token is still valid.
If the refresh token is also dead we'll see a 400 from `/oauth/token` — only
then do we need to re-auth via the Etsy app dashboard.

## Steps

### 1. Pre-flight (5 min)

- Confirm Supabase is reachable: `curl -sf "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"`
- Confirm migrations are applied: query `trend_briefs`, `design_packages` exist, and `claim_pending_trend_brief` RPC is callable.
- Confirm `designs` storage bucket exists (Design uploads PNGs there). If missing, create it.

### 2. Narrow the niche seed list (1 min)

The default `NICHE_SEEDS` in `packages/scout/seeds.py` has 10 niches. For a
first quality pass, override to 2–3 with `NICHE_SEEDS_OVERRIDE` so we burn
~$0.10–0.15 on fal.ai instead of ~$0.50.

Suggested first batch: `"dog mom gifts,nurse appreciation gifts,funny retirement gifts"` — three different aesthetic registers (cute, professional, humor) to stress-test prompt builder generality.

### 3. Run Scout (real Etsy) (~1–2 min)

```bash
NICHE_SEEDS_OVERRIDE="dog mom gifts,nurse appreciation gifts,funny retirement gifts" \
python -m packages.scout.main
```

Expected: 3 rows in `trend_briefs` with `status='pending'`. Inspect one to confirm `claude_analysis` looks coherent (style_keywords are descriptive, top_tags are Etsy-shaped, no brand names leaked through).

If Scout fails on Etsy auth: refresh tokens manually, retry. If it fails on Claude JSON parsing: log the raw response and iterate on the system prompt — this would block the whole run.

### 4. Run Design (real fal.ai) (~3–5 min)

```bash
python -m packages.design.main
```

Design polls `trend_briefs` where `status='pending'`, claims one at a time via the `FOR UPDATE SKIP LOCKED` RPC, generates an image, processes to 300dpi PNG, uploads to Supabase Storage, marks the brief `done`.

Expected: 3 rows in `design_packages` each with an `image_url` pointing at Supabase Storage. Cost: ~3 × $0.05 = $0.15 on fal.ai.

### 5. Pull PNGs locally for inspection (1 min)

The PNGs sit in Supabase Storage as transparent-background 300dpi files. Two options:

**a) Just open the URLs in a browser.** Simplest. They're public if the bucket is public, signed if not. Print the URLs from `design_packages.image_url`.

**b) Download to `.tmp/designs/`** with a tiny script and open with `open .tmp/designs/`. Better if we want to compare side-by-side or run them through Photoshop.

I'll default to (b) and produce a one-file script that:
- pulls all `design_packages.image_url` from the latest run
- downloads them to `.tmp/designs/<niche-slug>.png`
- prints the joined `niche / fal_prompt / image_url` so we can map prompt → output

### 6. Quality verdict (manual, you do this)

For each PNG, decide:
- Does this look like something a real Etsy artist made, or AI slop?
- Is the composition centered, with breathing room around the edges (so it prints well at 12in × 12in)?
- Are there text artifacts (FLUX is famously bad at text — most POD t-shirts have text)?
- Is the transparent background actually transparent, or does it have white halos / artifacts?

Failure modes to expect on a first run:
- **FLUX renders text gibberish.** The prompt builder may be asking for typography it can't deliver. We may need to constrain the niche to non-text designs, or move to FLUX 1.1 Ultra / SDXL with text-aware ControlNet.
- **Transparent BG isn't truly clean.** `image_processor.py` does the bg removal — if there are halos, that's where to fix it.
- **Style mismatch.** Claude's prompt may be too generic, producing the same "vector cartoon" look regardless of niche. Iterate on `prompt_builder.py`.

## Optional: mockup-on-shirt preview

The Design agent's output is the print art alone. To judge "would this sell as a
t-shirt" you really want to see it on a t-shirt. Two paths:

- **Cheap, throwaway PIL script:** overlay each PNG on a stock heather-grey shirt template. Crude but free. Good enough for a gut-check.
- **Real Printify mockup:** create a draft Printify product (is_visible=false), read the auto-generated `mockup_urls`, optionally delete the product. This is code Listing will need anyway — building it now is not throwaway.

Recommend deferring this until step 6 confirms the print art itself is decent. If the print is bad, the mockup won't save it.

## Risks / costs

- **fal.ai cost:** ~$0.15 for 3 images; ~$0.50 if we run all 10 default niches. Negligible.
- **Etsy OAuth refresh failure:** if both tokens are dead, we're blocked on a manual re-auth. ~10 min if it happens.
- **Supabase migrations not applied / bucket missing:** could surface as cryptic FK errors. Handled in step 1.
- **Polluting the prod DB with low-quality test rows:** if `SUPABASE_URL` points at the prod project, these test rows will live there. Worth confirming this is OK or pointing at a local Supabase first.

## Decision points before executing

1. Is `SUPABASE_URL` pointing at prod or local? If prod, OK to write 3 trend_briefs + 3 design_packages there?
2. OK with the 3-niche starter list, or different niches?
3. Skip mockup preview for v1, or worth doing the PIL overlay?
