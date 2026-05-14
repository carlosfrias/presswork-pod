"""fal-ai/nano-banana-2 backend (Google Gemini-3 image model on fal).

Parallel to packages/design/gpt_image_client.py. Same fal_client singleton,
same `images:[{url,...}]` output envelope, so the downstream URL-threaded
pipeline (birefnet/bria → Pillow → upload) is unchanged. Like gpt-image-2,
nano-banana-2 produces native-resolution output, so the aura-sr upscaler
step in main.py (gated on FLUX) is correctly skipped.

Key model traits driving the call shape:
  - Natural-English prompts (1–3 sentences). The model explicitly dislikes
    tag-style lists and quality boosters; the prompt-builder already
    produces literal English for gpt-image-2 so we reuse that builder
    unmodified.
  - Resolution tier instead of quality tier. We map the existing
    image_quality column (low|medium|high) → 0.5K|1K|2K resolutions via
    NANO_BANANA_RESOLUTIONS. 4K isn't exposed because it doubles cost for
    output we'd downscale to fit the 4500×5400 print canvas anyway.
  - SynthID watermark — invisible, doesn't affect printability, but the
    legal/IP context is worth knowing.
  - safety_tolerance defaults are too permissive for POD; we pin to "2"
    via NANO_BANANA_SAFETY_TOLERANCE so generated subjects stay tame.
"""

from packages.design.constants import (
    NANO_BANANA_DEFAULT_QUALITY,
    NANO_BANANA_MODEL,
    NANO_BANANA_RESOLUTIONS,
    NANO_BANANA_SAFETY_TOLERANCE,
)
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import nano_banana_cost_usd, record_usage
from packages.shared_py.models import ImagePrompt


async def generate_image_url(
    prompt: ImagePrompt,
    *,
    quality: str | None = None,
) -> str:
    """Run fal-ai/nano-banana-2 and return the fal-hosted output URL.

    `quality` is the brief's image_quality tier ('low' | 'medium' | 'high').
    Falls through to NANO_BANANA_DEFAULT_QUALITY when None — common for
    cron-spawned briefs whose column is NULL. Translates internally to the
    model's resolution input via NANO_BANANA_RESOLUTIONS.
    """
    chosen_quality = quality or NANO_BANANA_DEFAULT_QUALITY
    resolution = NANO_BANANA_RESOLUTIONS.get(
        chosen_quality,
        NANO_BANANA_RESOLUTIONS[NANO_BANANA_DEFAULT_QUALITY],
    )
    client = fal_client_singleton()

    # Print canvas is 4500×5400 (5:6 portrait). Nano supports an explicit
    # aspect_ratio but not arbitrary pixel sizes — pick 5:4 (closest 5:6
    # neighbor in the supported enum: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5,
    # 3:4, 2:3, 9:16). 4:5 is also a candidate but slightly off — 5:4 keeps
    # output in landscape-leaning portrait which crops cleanly to print canvas.
    #
    # Actually: 4:5 (= 0.80) is closer to our target 5:6 (= 0.833) than 5:4
    # (= 1.25). Use 4:5 portrait. Final downscale to 4500×5400 in Pillow
    # adds minimal padding.
    result = await run_with_timeout(
        client,
        NANO_BANANA_MODEL,
        arguments={
            "prompt": prompt.prompt,
            "aspect_ratio": "4:5",
            "resolution": resolution,
            "num_images": 1,
            "output_format": "png",
            "safety_tolerance": NANO_BANANA_SAFETY_TOLERANCE,
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="nano_banana_2",
        cost_usd=nano_banana_cost_usd(chosen_quality),
        metadata={
            "model": NANO_BANANA_MODEL,
            "quality": chosen_quality,
            "resolution": resolution,
        },
    )

    return extract_output_url(result)
