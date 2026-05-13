"""fal.ai Bria RMBG 2.0 background remover.

Parallels packages/design/birefnet.py — same I/O contract (`{image_url}` in,
`{image: {url}}` out, transparent RGBA PNG), different fal model id and
slightly different pricing. Selected when runtime_flags.background_removal_mode
== "bria"; main.py dispatches on the mode.
"""

from packages.design.constants import BRIA_MODEL
from packages.shared_py.fal_http import (
    extract_output_url,
    fal_client_singleton,
    run_with_timeout,
)
from packages.shared_py.llm_usage import fal_cost_usd, record_usage


async def remove_background_bria_url(image_url: str) -> str:
    """Run Bria RMBG 2.0 on a fal-hosted URL, return the transparent-PNG fal URL.

    Per fal's documented schema, the only input field is `image_url`; there's
    no optional flag for background color, threshold, etc. — Bria handles the
    cutout decision internally. If the model ever exposes new knobs we'll add
    them here.
    """
    client = fal_client_singleton()

    result = await run_with_timeout(
        client,
        BRIA_MODEL,
        arguments={
            "image_url": image_url,
        },
    )

    record_usage(
        agent="design",
        provider="fal",
        operation="bria",
        cost_usd=fal_cost_usd(BRIA_MODEL),
        metadata={"model": BRIA_MODEL},
    )

    return extract_output_url(result)
