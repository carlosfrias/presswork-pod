# Plan: Vision-Aware Scout

Add the ability for Scout to send Etsy listing imagery to Claude alongside the current text metadata, so style/palette inference is grounded in actual designs instead of inferred from words. Off by default; toggled via env var.

---

## Goal

Today Scout sends only `{title, tags, price_usd, num_reviews}` per listing to Claude. The `color_palette` and `style_keywords` in the resulting `trend_brief` are effectively guesses derived from tokens like "watercolor" or "boho" in the metadata.

When the toggle is on, Scout will also fetch a small thumbnail per listing from Etsy and include them as image content blocks in the same Claude call. The text-only path remains the default and must stay byte-identical when the toggle is off.

---

## Toggle

New env var: `SCOUT_VISION_ENABLED` (default `false`).

Adds one field to `packages/shared_py/config.py`:

```python
# When True, Scout includes Etsy listing thumbnails as image content blocks
# in the analyzer call. Adds ~3-5× per-run token cost; off by default.
scout_vision_enabled: bool = False
```

Also adds `SCOUT_VISION_ENABLED=` to `.env.example` (currently does not exist in `.env.example`, will append).

Two related knobs (constants, not env vars — they're rarely tuned):

- `SCOUT_VISION_MAX_IMAGES = 12` — how many listings per niche send their thumbnail. Etsy already returns score-sorted, so we slice the top N. Cap exists to bound token cost.
- `SCOUT_VISION_THUMBNAIL_FIELD = "url_570xN"` — which Etsy CDN size variant to send. `570xN` is the smallest size that preserves enough detail for Claude to read color/style; smaller variants (`url_300x300`) sometimes show heavy compression artifacts on detailed designs.

---

## Touchpoints (estimated diff sizes)

| File | Change | Approx LOC |
|---|---|---|
| `packages/shared_py/config.py` | new `scout_vision_enabled` field | +5 |
| `packages/scout/etsy_client.py` | optional `includes=Images` param, doc update | +6 |
| `packages/scout/analyzer.py` | branch on toggle, build vision content blocks, system-prompt addendum | +40 |
| `packages/scout/main.py` | pass listings through unchanged; analyzer reads settings | 0 |
| `packages/scout/test_etsy_client.py` | new test for the `includes` query param | +20 |
| `packages/scout/test_analyzer.py` | new tests: toggle off = text-only, toggle on = images included, missing images = graceful skip | +60 |
| `.env.example` | append `SCOUT_VISION_ENABLED=false` | +1 |
| `CLAUDE.md` | one-line note in the Scout section | +1 |

Total: ~130 LOC across 7 files.

---

## Design Details

### 1. Etsy client — request images conditionally

`packages/scout/etsy_client.py:101` — `fetch_top_listings()`:

```python
async def fetch_top_listings(
    self, niche: str, limit: int = 25, *, include_images: bool = False
) -> list[dict]:
    params: dict[str, Any] = {
        "keywords": niche,
        "sort_on": "score",
        "limit": limit,
    }
    if include_images:
        # Etsy returns an `images` array per listing with multiple CDN size
        # variants (url_75x75 ... url_fullxfull). No rate-limit cost change.
        params["includes"] = "Images"
    # ... rest unchanged
```

Caller in `main.py` reads the toggle from settings and passes through. Default `False` preserves current behavior.

### 2. Analyzer — branch on toggle, build vision content blocks

`packages/scout/analyzer.py` — restructure `analyze_niche()`:

```python
async def analyze_niche(raw_listings: list[dict]) -> ClaudeAnalysis:
    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    if settings.scout_vision_enabled:
        content = _build_vision_content(raw_listings)
        system_prompt = SYSTEM_PROMPT + VISION_SYSTEM_ADDENDUM
    else:
        content = json.dumps(_slim_listings(raw_listings), indent=2)
        system_prompt = SYSTEM_PROMPT

    response = await client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    )
    # ... rest unchanged (JSON parse + ClaudeAnalysis.model_validate)
```

`_build_vision_content()` produces a multi-block content array:

```python
def _build_vision_content(raw_listings: list[dict]) -> list[dict]:
    slim = _slim_listings(raw_listings)
    blocks: list[dict] = [
        {
            "type": "text",
            "text": (
                "Below are the top Etsy listings for this niche. For each listing "
                "you will see its metadata followed by its primary thumbnail. Use "
                "the IMAGES as the primary source for style_keywords and color_palette; "
                "use titles/tags for niche framing and top_tags extraction. "
                "Respond with the structured JSON described in the system prompt."
            ),
        }
    ]
    for i, (slim_listing, raw_listing) in enumerate(
        zip(slim, raw_listings[: len(slim)], strict=False)
    ):
        thumb_url = _pick_thumbnail_url(raw_listing)
        if thumb_url is None:
            # Listing has no images in the Etsy response — include text only.
            blocks.append({"type": "text", "text": f"Listing {i}: {json.dumps(slim_listing)}"})
            continue
        blocks.append({"type": "text", "text": f"Listing {i}: {json.dumps(slim_listing)}"})
        blocks.append({"type": "image", "source": {"type": "url", "url": thumb_url}})
        if i + 1 >= SCOUT_VISION_MAX_IMAGES:
            break
    return blocks


def _pick_thumbnail_url(listing: dict) -> str | None:
    images = listing.get("images") or []
    if not images:
        return None
    first = images[0]
    return first.get(SCOUT_VISION_THUMBNAIL_FIELD) or first.get("url_fullxfull")
```

System-prompt addendum:

```python
VISION_SYSTEM_ADDENDUM = """

When images are provided, prefer evidence from the images over the metadata for
style_keywords and color_palette. The metadata is a starting hint; the images
are ground truth. If the images conflict with title/tag wording (e.g. tag says
"vintage" but the design is a flat modern vector), trust the image."""
```

### 3. Error handling

The toggle-on path has more failure surface (image URL fetch by Anthropic, image-too-large, image format issues). Strategy: **best-effort with fallback**, not fail-the-niche.

In `analyze_niche()`, when `scout_vision_enabled=True`, wrap the `messages.create` call in try/except:

```python
try:
    response = await client.messages.create(... vision content ...)
except anthropic.BadRequestError as e:
    if "image" in str(e).lower():
        log.warning(
            "scout_vision_fallback",
            action="scout_vision_fallback",
            error=str(e),
            status="degraded",
        )
        response = await client.messages.create(... text-only content ...)
    else:
        raise
```

So a single bad image URL for one niche degrades that niche's analysis to text-only instead of killing the whole run. The fallback is logged so we can see how often it fires.

### 4. Token cost / latency

Etsy's `url_570xN` is ~570px wide, typically ~30-80 KB JPG. Anthropic counts image tokens by dimensions: a 570px image at standard res = roughly 600-900 tokens.

At `SCOUT_VISION_MAX_IMAGES=12`:
- 12 images × ~750 tokens = ~9k image tokens per niche
- Plus ~1.5k text tokens (system + metadata)
- Total ~10-11k input tokens per niche, vs ~1.5k text-only

Per nightly Scout run (5 niches, when toggle is on):
- ~55k input tokens at Sonnet 4 pricing
- ≈ $0.16-0.25 per nightly run (vs ~$0.02 text-only)

Latency: image URL fetches are parallelized by Anthropic; expect +2-4s per niche call.

---

## Tests

### `test_etsy_client.py` (new)

```python
async def test_fetch_top_listings_includes_images_when_requested():
    # Patch httpx, capture params, assert includes=Images present
    ...

async def test_fetch_top_listings_omits_includes_by_default():
    # Default call has no `includes` param
    ...
```

### `test_analyzer.py` (new)

```python
async def test_vision_disabled_sends_text_only(mocker):
    # Toggle off → user content is a plain JSON string, no image blocks
    ...

async def test_vision_enabled_includes_image_blocks(mocker):
    # Toggle on → content is a list with type=image blocks pointing at thumbnail URLs
    ...

async def test_vision_falls_back_to_text_on_image_bad_request(mocker):
    # Vision call raises BadRequestError mentioning "image" → second call uses text-only,
    # final result still parses to ClaudeAnalysis
    ...

async def test_listing_with_no_images_sends_text_only_block(mocker):
    # Etsy returned a listing without an `images` field → no image block for it,
    # but the rest of the batch is unaffected
    ...
```

Mocks: extend the existing `_mock_client(mocker, response_text)` helper to allow toggling `BadRequestError` on first call.

---

## Validation Plan

After implementation, before merging:

1. Unit tests pass: `pytest packages/scout/ -q`
2. Smoke test with toggle off — `cd packages/scout && python main.py` against a single seed niche. Confirm trend_brief is byte-identical to a pre-change run (modulo timestamps).
3. Smoke test with toggle on — same niche, observe Slack log lines. Compare `color_palette` and `style_keywords` between the two runs and confirm the vision run produces tighter, more design-faithful values.
4. Cost check: run with `SCOUT_VISION_ENABLED=true` against 2 niches, confirm Anthropic dashboard shows ~10-12k input tokens per call.

---

## Out of Scope

These are real follow-ups but not in this change:

- Downloading + caching images locally (S3/Supabase Storage) instead of relying on Anthropic to fetch from Etsy CDN. Cleaner long-term but not needed for first cut.
- Persisting the thumbnail URLs (or local copies) into `trend_briefs.raw_etsy_data` for offline replay. Etsy URLs are stable so this is low-priority; revisit if rerun-on-historical-data becomes a workflow.
- Embedding-based image similarity for dedup (today's `is_semantic_duplicate` operates on niche strings only).
- Letting the Design agent see Scout's reference images. Would require passing image URLs through `trend_briefs` and onward to the FLUX prompt builder.

---

## Open Questions

1. **Image count cap**: is 12 the right value? Token cost scales linearly; could be 5 (cheap, weaker signal) or 20 (richer, ~50% more cost). Default 12; easy to retune.
2. **Vision-prompt placement of metadata**: the plan interleaves `Listing N: <json>` text blocks with image blocks. Alternative is to put all metadata in one upfront text block, then all images sequentially. Interleaving feels more legible; happy to flip if you prefer.
3. **Always fetch `includes=Images`, even when toggle is off?**: cost is zero on the Etsy side, and storing image URLs in `raw_etsy_data` would be useful for ad-hoc analysis later even when vision is disabled. Lean toward yes (always include) — keeps the toggle purely about whether to send to Claude. **Defaulting to yes in this plan.**

---

## Sign-off

If you approve this plan, the implementation order is:

1. Config field + `.env.example`
2. Etsy client: `include_images` param
3. Analyzer: vision content builder + fallback path
4. Wire `main.py` to pass through (one-line)
5. Tests for all three modules
6. Update `CLAUDE.md` Scout section
