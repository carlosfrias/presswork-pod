from packages.design.constants import BIREFNET_MODEL
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import fal_cost_usd, record_usage


async def remove_background_birefnet_url(image_url: str) -> str:
    """Run fal.ai birefnet v2 on a fal-hosted URL, return the transparent-PNG fal URL.

    Pure URL-in / URL-out: no upload, no download. Birefnet returns a
    transparent RGBA PNG by default (no `background_color` flag). The
    orchestrator in main.py downloads the result exactly once after this
    stage so Pillow can resize/pad to the print canvas.
    """
    client = fal_client_singleton()

    result = await run_with_timeout(
        client,
        BIREFNET_MODEL,
        arguments={
            "image_url": image_url,
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="birefnet",
        cost_usd=fal_cost_usd(BIREFNET_MODEL),
        metadata={"model": BIREFNET_MODEL},
    )

    return extract_output_url(result)
