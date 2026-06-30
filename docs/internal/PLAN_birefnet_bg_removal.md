# Plan: Default background removal via fal.ai birefnet v2

## Goal

Replace `rembg` + white-matte decontamination + screen-print interior strip as the **default** background-removal stack with a single fal.ai birefnet v2 call. Preserve the existing pipeline as an opt-in toggle for compatibility / fallback / experiments.

## Why

- `rembg` runs locally (U²-Net), needs the model on disk, leaves opaque rim slop that the `_erode_alpha_mask` + `_decontaminate_white_matte` + smoothstep curve only partially clean up.
- birefnet v2 is matting-quality, returns a clean transparent PNG, no rim slop, no per-pixel cleanup needed in the common case.
- Removes ~150 lines of edge-decontamination heuristics from the default path (still callable via toggle).

## Scope

In:
- New module `packages/design/birefnet.py` — fal.ai birefnet v2 call, URL-in / bytes-out, retry semantics matching `upscaler.py`.
- `packages/design/image_processor.py` — accept a `background_removal` mode; default `"birefnet"`, legacy `"rembg"`.
- `main.py` — call birefnet directly with the (already-URL-able) image, then hand transparent bytes to `process_for_print` for canvas/DPI work only.
- Config flag `BIREFNET_ENABLED` (default true) — emergency kill-switch.
- Tests: birefnet path mocked at HTTP layer; rembg legacy path retained behind toggle.

Out of scope:
- Removing the `rembg` dependency entirely (keep as fallback).
- Changing the upscaler order or aura-sr behavior.
- Changing the screen-print strip — it stays gated by `mode="screen_print"` and only runs in the legacy path. (Birefnet output is already cleanly transparent including interior negative space, so screen_print mode is essentially a no-op there.)

## New pipeline (default)

```
FLUX (URL out) → download bytes
   ↓
aura-sr (URL in / out, ~4096²) → bytes   [if upscaler_enabled]
   ↓
birefnet v2 (URL in / out, transparent) → bytes   [if birefnet_enabled — new default]
   ↓
Pillow: _resize_with_padding → 4500×5400 @ 300 DPI
```

## Legacy pipeline (opt-in)

`background_removal="rembg"` keeps the current rembg → erode → decontaminate → (optional screen_print strip) → Pillow path verbatim.

## API shape (image_processor.py)

```python
BackgroundRemoval = Literal["birefnet", "rembg"]

def process_for_print(
    png_bytes: bytes,
    *,
    mode: PrintMode = "full_color",
    background_removal: BackgroundRemoval = "birefnet",
    skip_cleanup: bool = False,
) -> bytes
```

- `background_removal="birefnet"`: caller is expected to pass already-transparent bytes (birefnet ran upstream in main.py). `process_for_print` does NOT call birefnet itself — it only resizes/pads. Reason: birefnet is an async HTTP call; keeping it out of the sync Pillow path matches the upscaler design and keeps `process_for_print` testable without HTTP mocks.
- `background_removal="rembg"`: current behavior — sync `rembg_remove` + cleanup + Pillow.
- `skip_cleanup=True`: unchanged, takes precedence.

Wiring: `main.py` checks `background_removal_mode`, calls `await remove_background_birefnet(png_bytes)` if "birefnet", then hands the result to `process_for_print(..., background_removal="birefnet")` which only does the Pillow canvas step.

## fal.ai endpoint

Model: `fal-ai/birefnet/v2` (matting-quality variant). Input: `{ image_url }`. Output: `{ image: { url } }` pointing at a transparent PNG.

Confirm exact arg name (`image_url` vs `image`) and any model-specific knobs (e.g. `output_format`, `enable_refinement`) when wiring — fal docs are the source of truth.

## Config

Add to `packages/shared_py/config.py`:

```python
birefnet_enabled: bool = True
background_removal_mode: Literal["birefnet", "rembg"] = "birefnet"
```

`.env.example`:
```
BIREFNET_ENABLED=true
BACKGROUND_REMOVAL_MODE=birefnet
```

## Tests

New (`test_birefnet.py`):
- HTTP mock returns transparent PNG; bytes round-trip correctly.
- Retry semantics on 5xx / network errors (3 attempts).
- 4xx fails immediately (mirrors upscaler.py `_is_retryable`).

Updates (`test_image_processor.py`):
- New: `background_removal="birefnet"` path skips rembg entirely, only resizes/pads/sets DPI, preserves input alpha.
- New: default param value is `"birefnet"`.
- Existing rembg tests: pass `background_removal="rembg"` explicitly so they keep covering the legacy branch.

New (`test_main_pipeline.py` or extend existing):
- Default flag path: birefnet called once, rembg never called.
- `BACKGROUND_REMOVAL_MODE=rembg` path: birefnet never called, rembg called once.

## Rollout

1. Land code behind `BACKGROUND_REMOVAL_MODE` with `"birefnet"` as default in `.env.example` but `"rembg"` as the **temporary** default in code until a cloud smoke run confirms birefnet output looks right on a real FLUX design.
2. Flip code default to `"birefnet"` after smoke ✔.
3. Keep `rembg` dependency for ~one release in case of regression; remove from `requirements.txt` once birefnet has run uneventfully for a week.

## Risks

- Birefnet quality on FLUX-style flat illustration is unverified — smoke test on at least 3 representative designs before flipping the default.
- Extra fal.ai call adds ~$0.0X/image + latency. Budget impact small; capture in observability via existing duration_ms logging.
- Two upstream fal calls (aura-sr + birefnet) widen the failure surface. Each has its own retry budget; soft-fail wrapper in `main.py` already handles upscaler — extend the same pattern to birefnet (fall back to `rembg` path on birefnet failure rather than failing the whole design).

## Open questions

- Confirm fal model id: `fal-ai/birefnet` vs `fal-ai/birefnet/v2`. (Pending: check fal docs.)
- Should birefnet failure fall back to rembg (soft-fail) or fail the design (hard)? Recommend soft-fail to rembg with a Slack warn, matching upscaler precedent.

## Effort

~150 lines new code, ~30 lines changed in main.py, ~120 lines test. ½ day.
