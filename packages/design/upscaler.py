import fal_client
import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from packages.design.constants import UPSCALER_MODEL, UPSCALER_SCALE
from packages.shared_py.config import get_settings


def _is_retryable(exc: BaseException) -> bool:
    # Mirrors fal_client._is_retryable: 5xx + transient network errors retry,
    # 4xx fails immediately. Keeps upscaler retry semantics consistent with the
    # FLUX call so the soft-fail wrapper in main.py sees the same exception shape.
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return isinstance(exc, (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException))


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception(_is_retryable),
    reraise=True,
)
async def _download_image(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


async def upscale_image(png_bytes: bytes) -> bytes:
    """4× super-resolution of a PNG via fal.ai aura-sr.

    Takes the raw RGB bytes returned by `generate_image()` (1024² from FLUX),
    uploads to fal storage, runs aura-sr, downloads the upscaled result.
    Returns ~4096² PNG bytes. Errors propagate to the soft-fail wrapper in
    main.py — callers should expect this can raise on network/API failures.
    """
    settings = get_settings()
    client = fal_client.AsyncClient(key=settings.fal_key)

    # aura-sr takes `image_url`, not raw bytes. fal_client.upload returns a
    # temporary URL pointing at the blob. Lifecycle is ephemeral by default,
    # so we don't need explicit cleanup.
    image_url = await client.upload(png_bytes, "image/png", "input.png")

    result = await client.run(
        UPSCALER_MODEL,
        arguments={
            "image_url": image_url,
            "upscaling_factor": UPSCALER_SCALE,
            # Overlapping tiles smooth seams on the SR network's tile boundaries
            # at the cost of ~2× compute. Worth it for clean print output.
            "overlapping_tiles": True,
        },
    )

    upscaled_url: str = result["image"]["url"]
    return await _download_image(upscaled_url)
