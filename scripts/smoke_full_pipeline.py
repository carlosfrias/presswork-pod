"""End-to-end Design pipeline smoke: FLUX → aura-sr → birefnet → Pillow.

Runs the full URL-threaded production pipeline against a user-supplied prompt
and saves the intermediate outputs at each stage. Useful for eyeballing how
a new prompt or style direction reads through the whole pipeline before it
gets used in the nightly cron.

Cost: ~$0.08-0.12 per run (FLUX ~$0.05 + aura-sr ~$0.02 + birefnet ~$0.03).

Usage:
    source .venv/bin/activate
    python -m scripts.smoke_full_pipeline \\
        --prompt "your prompt here" \\
        [--negative "your negative prompt"] \\
        [--slug short-name-for-output-dir]

Outputs in .tmp/smoke-full-pipeline/<slug>/:
    1-flux.png             raw FLUX output (RGB, white background)
    2-upscaled.png         after aura-sr 4× (RGB, ~4×4× pixels, still white bg)
    3-birefnet.png         transparent RGBA — full canvas, just bg removal
    4-print.png            final 4500×5400 @ 300 DPI print-ready PNG
    summary.json           durations, file sizes, fal URLs, prompt
"""

from __future__ import annotations

import argparse
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

from packages.design.birefnet import remove_background_birefnet_url
from packages.design.fal_client import generate_image_url
from packages.design.image_processor import process_for_print
from packages.design.upscaler import upscale_url
from packages.shared_py import fal_http as fal_http_module
from packages.shared_py.fal_http import download_image
from packages.shared_py.models import FluxPrompt

OUT_ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "smoke-full-pipeline"


def _patch_settings_for_smoke() -> None:
    """Same pattern as scripts/smoke_birefnet.py / smoke_flux_aspect.py — the
    local .env doesn't have the full Settings surface, so stub get_settings()
    to return just the fal_key."""
    fal_key = os.environ.get("FAL_KEY")
    if not fal_key:
        print("[smoke] FAL_KEY missing from environment / .env", file=sys.stderr)
        sys.exit(2)
    fal_http_module.get_settings = lambda: SimpleNamespace(fal_key=fal_key)  # type: ignore[assignment]
    fal_http_module.fal_client_singleton.cache_clear()


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:48] or "design"


async def _amain() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True, help="The FLUX prompt verbatim.")
    parser.add_argument(
        "--negative",
        default="blurry, low quality, text, watermark, signature",
        help="Negative prompt (defaults to a generic anti-noise list).",
    )
    parser.add_argument(
        "--slug",
        default=None,
        help="Short identifier for the output directory (default: derived from prompt + timestamp).",
    )
    parser.add_argument(
        "--skip-upscale",
        action="store_true",
        help="Skip the aura-sr step (cheaper smoke, ~1/3 the cost).",
    )
    args = parser.parse_args()

    load_dotenv()
    _patch_settings_for_smoke()

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = args.slug or _slug(args.prompt.split(",")[0])
    out_dir = OUT_ROOT / f"{slug}-{timestamp}"
    out_dir.mkdir(parents=True, exist_ok=True)

    flux_prompt = FluxPrompt(
        prompt=args.prompt,
        negative_prompt=args.negative,
        style_descriptors=[],
    )

    print(f"[smoke] out_dir = {out_dir}")
    print(f"[smoke] prompt: {args.prompt[:120]}{'...' if len(args.prompt) > 120 else ''}")
    print("[smoke] estimated cost: ~$0.10 (FLUX + aura-sr + birefnet)")

    # --- Stage 1: FLUX ---
    t0 = time.monotonic()
    flux_url = await generate_image_url(flux_prompt)
    t_flux_ms = round((time.monotonic() - t0) * 1000)
    flux_bytes = await download_image(flux_url)
    (out_dir / "1-flux.png").write_bytes(flux_bytes)
    flux_w, flux_h = Image.open(io.BytesIO(flux_bytes)).size
    print(f"[smoke] 1) FLUX        {flux_w}×{flux_h}  ({len(flux_bytes) // 1024}KB)  {t_flux_ms}ms")

    # --- Stage 2: aura-sr 4× ---
    if args.skip_upscale:
        work_url = flux_url
        upscaled_w, upscaled_h = flux_w, flux_h
        upscaled_size_kb = len(flux_bytes) // 1024
        t_upscale_ms = 0
        print("[smoke] 2) upscale    SKIPPED (--skip-upscale)")
    else:
        t1 = time.monotonic()
        work_url = await upscale_url(flux_url)
        t_upscale_ms = round((time.monotonic() - t1) * 1000)
        upscaled_bytes = await download_image(work_url)
        (out_dir / "2-upscaled.png").write_bytes(upscaled_bytes)
        upscaled_w, upscaled_h = Image.open(io.BytesIO(upscaled_bytes)).size
        upscaled_size_kb = len(upscaled_bytes) // 1024
        print(
            f"[smoke] 2) aura-sr 4×  {upscaled_w}×{upscaled_h}  "
            f"({upscaled_size_kb}KB)  {t_upscale_ms}ms"
        )

    # --- Stage 3: birefnet ---
    t2 = time.monotonic()
    birefnet_url = await remove_background_birefnet_url(work_url)
    t_birefnet_ms = round((time.monotonic() - t2) * 1000)
    transparent_bytes = await download_image(birefnet_url)
    (out_dir / "3-birefnet.png").write_bytes(transparent_bytes)
    bf_w, bf_h = Image.open(io.BytesIO(transparent_bytes)).size
    print(
        f"[smoke] 3) birefnet    {bf_w}×{bf_h}  "
        f"({len(transparent_bytes) // 1024}KB transparent RGBA)  {t_birefnet_ms}ms"
    )

    # --- Stage 4: Pillow → 4500×5400 @ 300 DPI ---
    t3 = time.monotonic()
    print_bytes = process_for_print(transparent_bytes, background_removal="birefnet")
    (out_dir / "4-print.png").write_bytes(print_bytes)
    t_pillow_ms = round((time.monotonic() - t3) * 1000)
    pr_w, pr_h = Image.open(io.BytesIO(print_bytes)).size
    print(
        f"[smoke] 4) print-ready {pr_w}×{pr_h} @ 300 DPI  "
        f"({len(print_bytes) // 1024}KB)  {t_pillow_ms}ms"
    )

    summary = {
        "timestamp": timestamp,
        "slug": slug,
        "prompt": args.prompt,
        "negative_prompt": args.negative,
        "skip_upscale": args.skip_upscale,
        "stages": {
            "flux": {
                "dimensions": [flux_w, flux_h],
                "size_kb": len(flux_bytes) // 1024,
                "duration_ms": t_flux_ms,
                "url": flux_url,
            },
            "upscale": {
                "dimensions": [upscaled_w, upscaled_h],
                "size_kb": upscaled_size_kb,
                "duration_ms": t_upscale_ms,
                "skipped": args.skip_upscale,
            },
            "birefnet": {
                "dimensions": [bf_w, bf_h],
                "size_kb": len(transparent_bytes) // 1024,
                "duration_ms": t_birefnet_ms,
            },
            "pillow": {
                "dimensions": [pr_w, pr_h],
                "size_kb": len(print_bytes) // 1024,
                "duration_ms": t_pillow_ms,
            },
        },
        "out_dir": str(out_dir),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"\n[smoke] done. open {out_dir}")
    return 0


def main() -> int:
    return asyncio.run(_amain())


if __name__ == "__main__":
    sys.exit(main())
