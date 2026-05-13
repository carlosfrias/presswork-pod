from packages.design.constants import FLUX_IMAGE_DIMENSIONS, FLUX_MODEL
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import fal_cost_usd, record_usage
from packages.shared_py.models import FluxPrompt


async def generate_image_url(prompt: FluxPrompt) -> str:
    """Run FLUX Pro 1.1 on fal and return the fal-hosted output URL.

    Unlike the old `generate_image(...) → bytes`, the URL is returned
    verbatim so downstream fal stages (aura-sr, birefnet) can consume it
    directly without us downloading + re-uploading bytes between every model.
    The orchestrator in `main.py` downloads once at the end of the chain,
    when Pillow needs the actual pixels.
    """
    client = fal_client_singleton()

    result = await run_with_timeout(
        client,
        FLUX_MODEL,
        arguments={
            "prompt": prompt.prompt,
            "negative_prompt": prompt.negative_prompt,
            "image_size": FLUX_IMAGE_DIMENSIONS,
            "num_images": 1,
            "output_format": "png",
            "safety_tolerance": "2",
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="flux_pro",
        cost_usd=fal_cost_usd(FLUX_MODEL),
        metadata={"model": FLUX_MODEL},
    )

    return extract_output_url(result)
