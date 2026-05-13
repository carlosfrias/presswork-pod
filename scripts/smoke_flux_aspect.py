"""One-off FLUX 5:6 aspect smoke.

Generates a single FLUX image at the new 1024×1232 dimensions (set in
packages/design/constants.py:FLUX_IMAGE_DIMENSIONS) and saves it locally for
eyeball inspection. Used to gate the FLUX aspect-ratio change before the
nightly design cron starts using it in production.

Cost: ~$0.05 per run. Don't run repeatedly.

Usage:
    source .venv/bin/activate
    python -m scripts.smoke_flux_aspect
    # → .tmp/smoke-flux-aspect/flux-5x6-<timestamp>.png + summary.json
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from dotenv import load_dotenv
from PIL import Image

from packages.design.constants import FLUX_IMAGE_DIMENSIONS
from packages.design.fal_client import generate_image_url
from packages.shared_py import fal_http as fal_http_module
from packages.shared_py.fal_http import download_image
from packages.shared_py.models import FluxPrompt

# A representative print-design prompt — centered subject, illustration style.
# Same template used by the Design agent in production (transparent-background
# language + vector-style anchor) so FLUX's composition behavior on this
# smoke matches what production will see.
_PROMPT = FluxPrompt(
    prompt=(
        "print on demand design, transparent background, high resolution, "
        "vector-style centered illustration of a sleeping fox curled up "
        "under a crescent moon, soft watercolor palette of muted oranges "
        "and deep blues, minimal hand-drawn linework, no text"
    ),
    negative_prompt="text, logo, signature, watermark, photo, photorealistic, blurry",
    style_descriptors=["watercolor", "minimalist"],
)

OUT_ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "smoke-flux-aspect"


def _patch_settings_for_smoke() -> None:
    """Same pattern as scripts/smoke_birefnet.py — local .env doesn't have
    the full Settings surface (Etsy, Supabase, etc.) so stub get_settings
    to return just the fal_key. Clear the lru_cache so the singleton
    rebuilds against the stubbed settings."""
    fal_key = os.environ.get("FAL_KEY")
    if not fal_key:
        print("[smoke] FAL_KEY missing from environment / .env", file=sys.stderr)
        sys.exit(2)
    fal_http_module.get_settings = lambda: SimpleNamespace(fal_key=fal_key)  # type: ignore[assignment]
    fal_http_module.fal_client_singleton.cache_clear()


async def _amain() -> int:
    load_dotenv()
    _patch_settings_for_smoke()

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    width = FLUX_IMAGE_DIMENSIONS["width"]
    height = FLUX_IMAGE_DIMENSIONS["height"]

    print(f"[smoke] requesting FLUX {width}×{height} (5:6 portrait) — costs ~$0.05")
    t0 = time.monotonic()
    flux_url = await generate_image_url(_PROMPT)
    t_flux_ms = round((time.monotonic() - t0) * 1000)
    print(f"[smoke]   fal URL ready in {t_flux_ms}ms")
    print(f"[smoke]   url: {flux_url}")

    t1 = time.monotonic()
    png_bytes = await download_image(flux_url)
    t_dl_ms = round((time.monotonic() - t1) * 1000)

    out_path = OUT_ROOT / f"flux-{width}x{height}-{timestamp}.png"
    out_path.write_bytes(png_bytes)

    img = Image.open(io.BytesIO(png_bytes))
    actual_w, actual_h = img.size
    expected_match = (actual_w, actual_h) == (width, height)

    print(f"[smoke]   downloaded {len(png_bytes) // 1024}KB in {t_dl_ms}ms")
    print(f"[smoke]   actual dimensions: {actual_w}×{actual_h}")
    if not expected_match:
        print(
            f"[smoke]   ⚠ FLUX returned {actual_w}×{actual_h}, expected {width}×{height}",
            file=sys.stderr,
        )

    summary = {
        "timestamp": timestamp,
        "requested_dimensions": [width, height],
        "actual_dimensions": [actual_w, actual_h],
        "dimensions_match": expected_match,
        "file_size_kb": len(png_bytes) // 1024,
        "durations_ms": {"flux_generate": t_flux_ms, "download": t_dl_ms},
        "prompt": _PROMPT.prompt,
        "negative_prompt": _PROMPT.negative_prompt,
        "fal_url": flux_url,
        "output_path": str(out_path),
    }
    (OUT_ROOT / f"summary-{timestamp}.json").write_text(json.dumps(summary, indent=2))
    print(f"\n[smoke] done. open {out_path}")
    return 0 if expected_match else 1


def main() -> int:
    return asyncio.run(_amain())


if __name__ == "__main__":
    sys.exit(main())
