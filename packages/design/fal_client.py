import os

import fal_client
import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from packages.design.constants import FLUX_IMAGE_SIZE, FLUX_MODEL
from packages.shared_py.config import get_settings
from packages.shared_py.models import FluxPrompt


def _is_server_error(exc: BaseException) -> bool:
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception(_is_server_error),
    reraise=True,
)
async def _download_image(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


async def generate_image(prompt: FluxPrompt) -> bytes:
    settings = get_settings()
    os.environ["FAL_KEY"] = settings.fal_key

    result = await fal_client.run_async(
        FLUX_MODEL,
        arguments={
            "prompt": prompt.prompt,
            "negative_prompt": prompt.negative_prompt,
            "image_size": FLUX_IMAGE_SIZE,
            "num_images": 1,
            "output_format": "png",
            "safety_tolerance": "2",
        },
    )

    image_url: str = result["images"][0]["url"]
    return await _download_image(image_url)
