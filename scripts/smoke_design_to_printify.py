"""End-to-end synthetic smoke: Design agent → Printify production mockup.

Skips Scout (no real Etsy data) and skips Supabase (no DB writes / Storage uploads).
Builds a TrendBrief in memory, runs the real prompt builder + fal.ai + rembg +
image processor pipeline, then uploads the print PNG to Printify and creates a
hidden product so we get back the same mockups Etsy listings would use.

Usage:
    source .venv/bin/activate
    python -m scripts.smoke_design_to_printify

Outputs in .tmp/smoke/<slug>/:
    flux-prompt.json           the prompt Claude produced
    raw.png                    raw fal.ai output (before bg removal / resize)
    print.png                  300dpi transparent print-ready PNG (the listing image)
    mockup-NN.jpg              Printify-generated lifestyle mockups
    summary.json               URLs, product id, blueprint/variant info
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from packages.design.constants import (
    GILDAN_64000_BLUEPRINT_ID,
    GILDAN_64000_VARIANT_IDS,
)
from packages.design.fal_client import generate_image
from packages.design.image_processor import process_for_print
from packages.design.prompt_builder import build_flux_prompt
from packages.shared_py.config import get_settings
from packages.shared_py.models import TrendBrief

# Print provider that owns the Gildan 64000 variant IDs in design/constants.py.
# (Blueprint 145 + variants 38163/38177/38191/38205/38219 belong to Marco Fine Arts.)
PRINTIFY_PRINT_PROVIDER_ID = 3

OUT_ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "smoke"


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def _build_synthetic_brief() -> TrendBrief:
    """A different niche than the prior runs (dog mom, nurse, retirement).

    yoga is in the subject-centric keyword list, so this also exercises the
    'centered subject / no wallpaper' branch of prompt_builder.
    """
    now = datetime.now(UTC)
    return TrendBrief(
        id=uuid4(),
        created_at=now,
        updated_at=now,
        status="pending",
        niche="yoga instructor gifts",
        style_keywords=[
            "minimalist line art",
            "serene",
            "earthy boho",
            "hand-drawn",
            "spiritual",
        ],
        top_tags=[
            "yoga gift",
            "yoga instructor",
            "yoga teacher",
            "namaste",
            "meditation",
            "yogi",
            "lotus",
            "chakra",
            "mindfulness",
            "mantra",
        ],
        price_target_usd=24.99,
        color_palette=["sage green", "terracotta", "cream", "muted gold", "warm taupe"],
    )


def _printify_upload_image(api_token: str, png_bytes: bytes, file_name: str) -> str:
    """POST /v1/uploads/images.json — returns the upload id used by product creation.

    Printify accepts either a public URL or base64 contents. Base64 keeps this
    smoke test independent of Supabase Storage.
    """
    body = {
        "file_name": file_name,
        "contents": base64.b64encode(png_bytes).decode("ascii"),
    }
    r = httpx.post(
        "https://api.printify.com/v1/uploads/images.json",
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    upload_id = data.get("id")
    if not upload_id:
        raise RuntimeError(f"Printify upload returned no id: {data}")
    return upload_id


def _printify_create_product(
    api_token: str,
    shop_id: str,
    *,
    title: str,
    description: str,
    upload_id: str,
    blueprint_id: int,
    print_provider_id: int,
    variant_ids: list[int],
) -> dict[str, Any]:
    body = {
        "title": title,
        "description": description,
        "blueprint_id": blueprint_id,
        "print_provider_id": print_provider_id,
        "variants": [{"id": vid, "price": 2499, "is_enabled": True} for vid in variant_ids],
        "print_areas": [
            {
                "variant_ids": variant_ids,
                "placeholders": [
                    {
                        "position": "front",
                        "images": [
                            {
                                "id": upload_id,
                                "x": 0.5,
                                "y": 0.5,
                                "scale": 1,
                                "angle": 0,
                            }
                        ],
                    }
                ],
            }
        ],
        "is_visible": False,
    }
    r = httpx.post(
        f"https://api.printify.com/v1/shops/{shop_id}/products.json",
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=120,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Printify create product {r.status_code}: {r.text}")
    return r.json()


def _download_to(url: str, path: Path) -> None:
    with httpx.stream("GET", url, timeout=60) as r:
        r.raise_for_status()
        with path.open("wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)


async def main() -> int:
    settings = get_settings()

    brief = _build_synthetic_brief()
    out_dir = OUT_ROOT / _slug(brief.niche)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[smoke] niche={brief.niche!r} → {out_dir}")

    # 1) Claude → FLUX prompt (real prompt_builder, including subject-centric branch)
    t0 = time.monotonic()
    flux = build_flux_prompt(brief)
    (out_dir / "flux-prompt.json").write_text(
        json.dumps(
            {
                "prompt": flux.prompt,
                "negative_prompt": flux.negative_prompt,
                "style_descriptors": flux.style_descriptors,
            },
            indent=2,
        )
    )
    print(f"[smoke] prompt built in {round((time.monotonic() - t0) * 1000)}ms")

    # 2) fal.ai FLUX Pro 1.1 → raw PNG
    t1 = time.monotonic()
    raw_png = await generate_image(flux)
    (out_dir / "raw.png").write_bytes(raw_png)
    print(
        f"[smoke] fal.ai image generated ({len(raw_png) // 1024}KB) in {round((time.monotonic() - t1) * 1000)}ms"
    )

    # 3) rembg + 4500x5400 @300dpi
    t2 = time.monotonic()
    print_png = process_for_print(raw_png)
    (out_dir / "print.png").write_bytes(print_png)
    print(
        f"[smoke] processed to print-ready ({len(print_png) // 1024}KB) "
        f"in {round((time.monotonic() - t2) * 1000)}ms"
    )

    # 4) Printify upload (returns upload id, NOT a URL — production code needs this fix)
    t3 = time.monotonic()
    upload_id = _printify_upload_image(
        settings.printify_api_token,
        print_png,
        file_name=f"smoke-{_slug(brief.niche)}.png",
    )
    print(f"[smoke] printify upload id={upload_id} in {round((time.monotonic() - t3) * 1000)}ms")

    # 5) Printify create hidden product → returns auto-generated mockup URLs
    t4 = time.monotonic()
    product = _printify_create_product(
        settings.printify_api_token,
        settings.printify_shop_id,
        title=f"Yoga Instructor Gift Tee — Smoke {_slug(brief.niche)[:8]}",
        description="Smoke-test product. Hidden, not for sale.",
        upload_id=upload_id,
        blueprint_id=GILDAN_64000_BLUEPRINT_ID,
        print_provider_id=PRINTIFY_PRINT_PROVIDER_ID,
        variant_ids=GILDAN_64000_VARIANT_IDS,
    )
    product_id = product.get("id")
    images = product.get("images") or []
    mockup_urls = [img.get("src") for img in images if img.get("src")]
    print(
        f"[smoke] printify product={product_id} mockups={len(mockup_urls)} "
        f"in {round((time.monotonic() - t4) * 1000)}ms"
    )

    # 6) Download mockups locally
    for i, url in enumerate(mockup_urls):
        ext = ".jpg" if ".jpg" in url.lower() or ".jpeg" in url.lower() else ".png"
        _download_to(url, out_dir / f"mockup-{i:02d}{ext}")
    print(f"[smoke] downloaded {len(mockup_urls)} mockups → {out_dir}")

    # 7) Summary
    summary = {
        "niche": brief.niche,
        "flux_prompt": flux.prompt,
        "style_descriptors": flux.style_descriptors,
        "blueprint_id": GILDAN_64000_BLUEPRINT_ID,
        "print_provider_id": PRINTIFY_PRINT_PROVIDER_ID,
        "variant_ids": GILDAN_64000_VARIANT_IDS,
        "printify_upload_id": upload_id,
        "printify_product_id": product_id,
        "mockup_urls": mockup_urls,
        "out_dir": str(out_dir),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print("[smoke] done. open with:")
    print(f"  open {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
