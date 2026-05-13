from packages.design.constants import UPSCALER_MODEL, UPSCALER_SCALE
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import fal_cost_usd, record_usage


async def upscale_url(image_url: str) -> str:
    """Run aura-sr 4× on a fal-hosted URL, return the upscaled fal URL.

    Pure URL-in / URL-out: no upload, no download. The previous
    `upscale_image(bytes) → bytes` re-uploaded the FLUX output to fal storage
    to get a URL it could pass to aura-sr; that round-trip is now elided
    because main.py threads the FLUX output URL directly.
    """
    client = fal_client_singleton()

    result = await run_with_timeout(
        client,
        UPSCALER_MODEL,
        arguments={
            "image_url": image_url,
            "upscaling_factor": UPSCALER_SCALE,
            # Overlapping tiles smooth seams on the SR network's tile
            # boundaries at the cost of ~2× compute. Worth it for clean
            # print output.
            "overlapping_tiles": True,
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="aura_sr",
        cost_usd=fal_cost_usd(UPSCALER_MODEL),
        metadata={"model": UPSCALER_MODEL, "scale": UPSCALER_SCALE},
    )

    return extract_output_url(result)
