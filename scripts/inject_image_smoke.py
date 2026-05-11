"""Inject a local image into the Printify mockup pipeline (no Supabase, no Etsy).

    your image  → process_for_print (default: full_color; --mode screen_print for single-ink)
                → Printify upload
                → Printify hidden product (Gildan 64000)
                → download mockups

Usage:
    source .venv/bin/activate
    python -m scripts.inject_image_smoke path/to/image.png [--title "..."] [--mode screen_print]

Outputs in .tmp/smoke/<slug>/:
    source.png            the input bytes (copied for reference)
    print.png             after rembg + whitespace strip + 4500×5400 pad
    mockup-NN.jpg         Printify-generated lifestyle mockups
    summary.json          IDs, file sizes, mockup URLs
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from packages.design.constants import (
    GILDAN_64000_BLUEPRINT_ID,
    GILDAN_64000_PRINT_PROVIDER_ID,
    GILDAN_64000_VARIANT_IDS,
)
from packages.design.image_processor import process_for_print

# Smoke-only: lets you preview the same design on a dark shirt. The production
# design agent writes the white-tee IDs from constants.py to every row, so we
# don't override the constant — we just remap when --shirt-color black is set.
GILDAN_64000_BLACK_VARIANT_IDS: list[int] = [38164, 38178, 38192, 38206, 38220]
SHIRT_COLOR_VARIANTS = {
    "white": GILDAN_64000_VARIANT_IDS,
    "black": GILDAN_64000_BLACK_VARIANT_IDS,
}

OUT_ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "smoke"


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-") or "image"


def _printify_upload_image(api_token: str, png_bytes: bytes, file_name: str) -> str:
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
    variant_ids: list[int],
) -> dict[str, Any]:
    body = {
        "title": title,
        "description": description,
        "blueprint_id": GILDAN_64000_BLUEPRINT_ID,
        "print_provider_id": GILDAN_64000_PRINT_PROVIDER_ID,
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Path to source image (PNG recommended)")
    parser.add_argument(
        "--title",
        default=None,
        help="Printify product title (default: derived from filename)",
    )
    parser.add_argument(
        "--mode",
        choices=("full_color", "screen_print"),
        default="full_color",
        help="Image processing mode (default: full_color; use screen_print for single-ink art)",
    )
    parser.add_argument(
        "--shirt-color",
        choices=tuple(SHIRT_COLOR_VARIANTS.keys()),
        default="white",
        help="Mockup shirt color (default: white). Smoke-only override; does not change production constants.",
    )
    args = parser.parse_args()

    if not args.image.exists():
        print(f"[smoke] image not found: {args.image}", file=sys.stderr)
        return 2

    load_dotenv()
    printify_token = os.environ.get("PRINTIFY_API_TOKEN")
    printify_shop = os.environ.get("PRINTIFY_SHOP_ID")
    if not printify_token or not printify_shop:
        print("[smoke] missing PRINTIFY_API_TOKEN or PRINTIFY_SHOP_ID in .env", file=sys.stderr)
        return 2

    stem = args.image.stem
    slug = _slug(stem)
    title = args.title or f"Smoke — {stem[:48]}"
    # Tag color into the output dir so back-to-back white/black runs don't trample each other.
    out_dir = OUT_ROOT / f"{slug}-{args.shirt_color}"
    out_dir.mkdir(parents=True, exist_ok=True)
    variant_ids = SHIRT_COLOR_VARIANTS[args.shirt_color]

    source_bytes = args.image.read_bytes()
    source_ext = args.image.suffix.lower() or ".bin"
    (out_dir / f"source{source_ext}").write_bytes(source_bytes)
    print(f"[smoke] {args.image} ({len(source_bytes) // 1024}KB) → {out_dir}  mode={args.mode}")

    t0 = time.monotonic()
    print_bytes = process_for_print(source_bytes, mode=args.mode)
    (out_dir / "print.png").write_bytes(print_bytes)
    t_proc_ms = round((time.monotonic() - t0) * 1000)
    print(f"[smoke]   processed ({len(print_bytes) // 1024}KB) in {t_proc_ms}ms")

    t1 = time.monotonic()
    upload_id = _printify_upload_image(
        printify_token,
        print_bytes,
        file_name=f"smoke-{slug}.png",
    )
    product = _printify_create_product(
        printify_token,
        printify_shop,
        title=title,
        description="Smoke-test product. Hidden, not for sale.",
        upload_id=upload_id,
        variant_ids=variant_ids,
    )
    product_id = product.get("id")
    images = product.get("images") or []
    mockup_urls = [img.get("src") for img in images if img.get("src")]
    t_pf_ms = round((time.monotonic() - t1) * 1000)
    print(f"[smoke]   printify product={product_id} mockups={len(mockup_urls)} in {t_pf_ms}ms")

    for i, url in enumerate(mockup_urls):
        ext = ".jpg" if (".jpg" in url.lower() or ".jpeg" in url.lower()) else ".png"
        _download_to(url, out_dir / f"mockup-{i:02d}{ext}")
    if mockup_urls:
        print(f"[smoke]   downloaded {len(mockup_urls)} mockups")

    summary = {
        "source": str(args.image),
        "mode": args.mode,
        "shirt_color": args.shirt_color,
        "variant_ids": variant_ids,
        "title": title,
        "durations_ms": {"process": t_proc_ms, "printify": t_pf_ms},
        "file_sizes_kb": {
            "source": len(source_bytes) // 1024,
            "print": len(print_bytes) // 1024,
        },
        "printify_upload_id": upload_id,
        "printify_product_id": product_id,
        "mockup_urls": mockup_urls,
        "out_dir": str(out_dir),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"\n[smoke] done. open {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
