"""Shared fal.ai HTTP plumbing.

All three Design-agent fal helpers (`fal_client`, `upscaler`, `birefnet`)
previously redefined the same `_download_image` + `_is_retryable` pair. This
module consolidates them so retry semantics stay aligned and the soft-fail
wrapper in `main.py` sees a uniform exception shape across stages.

Also exposes `extract_output_url` for defensive response-shape handling —
fal returns either `{"image": {"url": ...}}` or `{"images": [{"url": ...}]}`
depending on the model, and the shape sometimes shifts between API versions.
"""

import asyncio
from functools import lru_cache
from typing import Any, cast

import fal_client
import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from packages.shared_py.config import get_settings


class FalTimeoutError(RuntimeError):
    """Raised when a fal.ai model call exceeds its wall-clock budget.

    fal's `AsyncClient.run` polls the queue endpoint until a result lands.
    On a server-side failure (4xx, validation error, queue stall) the call can
    block indefinitely instead of raising — we've observed gpt-image-2
    rejections that left a Python process hanging on an open HTTPS stream
    until the operator killed it. Wrapping every fal call in `run_with_timeout`
    forces an exit so main.py's `except Exception` block can mark the row as
    error and surface the failure on the dashboard.
    """


# Default per-stage timeout in seconds. gpt-image-2 'high' is the slowest
# known call (~60-180s typical), so 300s gives a comfortable buffer without
# letting a wedged poll consume an entire agent run.
DEFAULT_FAL_TIMEOUT_S = 300.0


async def run_with_timeout(
    client: fal_client.AsyncClient,
    model: str,
    *,
    arguments: dict[str, Any],
    timeout_s: float = DEFAULT_FAL_TIMEOUT_S,
) -> dict[str, Any]:
    """Wrap `client.run` in `asyncio.wait_for` so a wedged poll can't hang
    the design pipeline. On timeout, raises FalTimeoutError — main.py's
    catch path handles it like any other fal error (write status=error,
    notify Slack)."""
    try:
        return await asyncio.wait_for(
            client.run(model, arguments=arguments),
            timeout=timeout_s,
        )
    except TimeoutError as exc:
        raise FalTimeoutError(
            f"fal call to {model!r} exceeded {timeout_s}s — likely a queue "
            f"stall or silently-rejected request. Check fal.ai's dashboard "
            f"for the request status; if it shows a 4xx/validation error "
            f"there but no exception here, the SDK swallowed it."
        ) from exc


def is_retryable(exc: BaseException) -> bool:
    # 5xx + transient network errors retry, 4xx fails immediately. Mirrors
    # fal_client._is_retryable so the soft-fail wrappers in main.py see a
    # uniform exception shape across fal models.
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return isinstance(exc, (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException))


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception(is_retryable),
    reraise=True,
)
async def download_image(url: str) -> bytes:
    """Download an image URL with the same retry budget every fal stage uses.

    Promoted out of three duplicate `_download_image` definitions. The 3-attempt
    cap matches the per-stage budget — combined with the upstream design-level
    retry counter on `design_packages.retry_count`, the worst-case retry surface
    per design is bounded.
    """
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


def extract_output_url(result: dict[str, Any]) -> str:
    """Extract the output URL from a fal model response, defensively.

    Different fal models return different envelope shapes:
      - aura-sr / birefnet (singular) → `{"image": {"url": ...}}`
      - FLUX                (plural)  → `{"images": [{"url": ...}]}`

    Try both before failing loudly so a fal-side response-shape tweak (or a
    new model added with the other convention) doesn't silently break the
    pipeline.
    """
    image = result.get("image")
    if isinstance(image, dict) and isinstance(image.get("url"), str):
        return cast(str, image["url"])
    images = result.get("images")
    if isinstance(images, list) and images and isinstance(images[0], dict):
        url = images[0].get("url")
        if isinstance(url, str):
            return url
    raise ValueError(f"fal response missing image url; keys={list(result.keys())}")


@lru_cache
def fal_client_singleton() -> fal_client.AsyncClient:
    """Module-level fal AsyncClient. Per-call instantiation in the old code
    paid a small constructor cost per design — lazy-init via lru_cache so the
    key is read from settings exactly once."""
    return fal_client.AsyncClient(key=get_settings().fal_key)
