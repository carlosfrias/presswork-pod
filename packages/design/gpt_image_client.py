"""fal-hosted openai/gpt-image-2 backend.

Parallel to packages/design/fal_client.py (which calls FLUX Pro 1.1). Same
fal_client singleton, same `images:[{url,...}]` output envelope, so the rest
of the URL-threaded pipeline (birefnet → Pillow → upload) is unchanged. The
aura-sr upscaler step in main.py is gated on FLUX, so this backend skips it.
"""

from packages.design.constants import (
    GPT_IMAGE_DEFAULT_QUALITY,
    GPT_IMAGE_DIMENSIONS,
    GPT_IMAGE_MODEL,
)
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import gpt_image_cost_usd, record_usage
from packages.shared_py.models import ImagePrompt


async def generate_image_url(
    prompt: ImagePrompt,
    *,
    quality: str | None = None,
) -> str:
    """Run openai/gpt-image-2 on fal and return the fal-hosted output URL.

    `quality` is the gpt-image-2 quality tier ('low' | 'medium' | 'high').
    Falls through to GPT_IMAGE_DEFAULT_QUALITY when caller passes None — that's
    the common path for cron-spawned briefs whose `image_quality` column is
    NULL. The brief-level override lets operators bump a specific brief to
    'high' from the dashboard inject form.
    """
    chosen_quality = quality or GPT_IMAGE_DEFAULT_QUALITY
    client = fal_client_singleton()

    result = await run_with_timeout(
        client,
        GPT_IMAGE_MODEL,
        arguments={
            "prompt": prompt.prompt,
            "image_size": GPT_IMAGE_DIMENSIONS,
            "quality": chosen_quality,
            "num_images": 1,
            "output_format": "png",
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="gpt_image_2",
        cost_usd=gpt_image_cost_usd(chosen_quality),
        metadata={
            "model": GPT_IMAGE_MODEL,
            "quality": chosen_quality,
            "image_size": GPT_IMAGE_DIMENSIONS,
        },
    )

    return extract_output_url(result)
