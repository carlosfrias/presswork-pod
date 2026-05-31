STORAGE_BUCKET = "designs"

# Blueprint and variant IDs for Gildan 64000 Softstyle Unisex T-Shirt.
# Source: GET https://api.printify.com/v1/catalog/blueprints.json (blueprint 145 = "Unisex Softstyle T-Shirt")
# These declare the intended product on each design_packages row; the Listing Agent
# uses them when creating the Printify product (which also yields the mockup images).
GILDAN_64000_BLUEPRINT_ID: int = 145

# Print provider that owns the variant IDs below. Printify variant IDs are scoped
# to a (blueprint_id, print_provider_id) pair — the White IDs listed below
# (38163, 38177, 38191, 38205, 38219) resolve under print_provider_id=39 (SwiftPOD)
# for blueprint 145. IDs are blueprint-scoped; the same White variant IDs were
# valid under the prior provider (Marco Fine Arts, id=3) and remain valid here.
# The Listing Agent passes this value into the create-product call alongside
# blueprint_id; mismatched pairs are rejected by Printify's API.
GILDAN_64000_PRINT_PROVIDER_ID: int = 39

# White t-shirt, sizes S / M / L / XL / 2XL
GILDAN_64000_VARIANT_IDS: list[int] = [38163, 38177, 38191, 38205, 38219]

FLUX_MODEL = "fal-ai/flux-pro/v1.1"

# OpenAI's gpt-image-2 routed through fal. Same FAL_KEY, same client, same
# `images:[{url,...}]` envelope as FLUX — drop-in compatible with the URL-
# threaded pipeline. Output goes straight to birefnet; the aura-sr upscaler
# step in main.py is gated on FLUX so this backend skips it.
GPT_IMAGE_MODEL = "openai/gpt-image-2"

# Custom size for gpt-image-2: portrait, multiples of 16, total pixels under
# fal's 8.29M cap (2560×3072 = 7.86M). Native large enough that the final
# Pillow scale to 4500×5400 is only ~1.76× — no fal-side upscale needed.
GPT_IMAGE_DIMENSIONS: dict[str, int] = {"width": 2560, "height": 3072}

# Quality tier when the brief doesn't override. `low` is the explore default
# (~$0.012/image — 6.7× cheaper than medium at $0.08, ~25× cheaper than high
# at $0.30). Operators bump to medium/high per-brief from the dashboard inject
# form when a design needs more fidelity. Lowered from `medium` after the
# bg-only re-mask path landed — fewer wasted full regens now, so cheaper
# first-pass exploration pays off.
GPT_IMAGE_DEFAULT_QUALITY = "low"


# Google's Gemini-3-based image model served on fal.ai. Natural-English
# prompts (1–3 sentences, no tag lists, no "masterpiece, best quality"
# boosters). Outputs PNG/JPEG/WebP at 0.5K/1K/2K/4K — no native transparent
# background, so the same birefnet/bria post-processing pipeline applies as
# for FLUX. Carries an invisible SynthID watermark on every output.
NANO_BANANA_MODEL = "fal-ai/nano-banana-2"

# Resolution tier mapping for nano-banana-2 — we reuse the existing
# image_quality column (low|medium|high) instead of inventing a new schema.
# Costs at each tier (per fal's published pricing, base $0.08 × multiplier):
#   low    → 0.5K  ($0.06)
#   medium → 1K    ($0.08)  ← default, rough parity with gpt-image-2 medium
#   high   → 2K    ($0.12)
NANO_BANANA_RESOLUTIONS: dict[str, str] = {
    "low": "0.5K",
    "medium": "1K",
    "high": "2K",
}
# Explore default — 0.5K @ $0.06/image. Bump per-brief from the inject form
# when a design needs finer detail. Matches the gpt-image-2 default flip
# made in the same pass for cost consistency across backends.
NANO_BANANA_DEFAULT_QUALITY = "low"

# Mid-permissive safety setting — matches the project's general "moderate"
# stance. The fal scale is 1 (strictest) → 6 (most permissive); 2 is just
# above strict. Bump only if a niche needs it; never go above 4 on this shop.
NANO_BANANA_SAFETY_TOLERANCE = "2"


# Near-5:6 portrait — closest FLUX-supported dimensions to the 4500×5400
# print canvas (true 5:6 = 1024 × 6/5 = 1228.8).
#
# Empirical finding from scripts/smoke_flux_aspect.py: FLUX Pro 1.1's internal
# grid is multiples of 32. We initially tried 1024×1232 (mult-of-16) but fal
# silently snapped it to 1024×1216 in the returned image. Using 1216 directly
# avoids the requested-vs-actual mismatch in logs.
#
# Aspect 1024:1216 = 0.842 (target 0.833). Close enough — after aura-sr 4×
# this lands at 4096×4864 vs the previous 4096×4096. The print canvas
# (4500×5400) then needs ~202px horizontal + ~268px vertical padding instead
# of ~202px horizontal + ~652px vertical — fill ratio rises from 68.7% → 82.0%.
FLUX_IMAGE_DIMENSIONS: dict[str, int] = {"width": 1024, "height": 1216}

# aura-sr is a feed-forward (GAN-style) 4× upscaler. Deterministic, ~3-6s,
# preserves graphic-style lines without diffusion drift. Fed the raw FLUX RGB
# output BEFORE fal.ai background removal so it sees clean pixels.
UPSCALER_MODEL = "fal-ai/aura-sr"
UPSCALER_SCALE = 4

# BiRefNet v2 — matting-quality background remover. Selected when
# runtime_flags.background_removal_mode == "birefnet". Takes `{image_url}`,
# returns `{image: {url}}` with a transparent RGBA PNG.
BIREFNET_MODEL = "fal-ai/birefnet/v2"

# Bria RMBG 2.0 — commercially-licensed background remover (current default).
# Same I/O shape as BiRefNet so it's a drop-in mode-switch in main.py:
# input `{image_url}`, output `{image: {url}}`, transparent RGBA PNG.
# Selected when runtime_flags.background_removal_mode == "bria".
BRIA_MODEL = "fal-ai/bria/background/remove"

OUTPUT_DPI = 300
OUTPUT_DIMENSIONS_PX = (4500, 5400)  # t-shirt print area at 300dpi (15"×18")
