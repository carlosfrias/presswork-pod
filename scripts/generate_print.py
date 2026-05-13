"""Generate print-ready PNGs from raw images — no Printify API calls.

    your image (path, URL, or folder) → process_for_print → print.png
                                      → [optional] composite onto shirt template → JPG

Usage:
    source .venv/bin/activate

    # single image
    python -m scripts.generate_print path/to/image.png

    # remote URL
    python -m scripts.generate_print "https://fal.media/..."

    # batch — every PNG/JPG/JPEG/WEBP in a folder (non-recursive)
    python -m scripts.generate_print path/to/folder

    # add a shirt mockup composite (white tee only)
    python -m scripts.generate_print path/to/image.png --shirt

Inputs are expected to already have transparent backgrounds (e.g. fal.ai
birefnet/bria output, Photoshop exports). `process_for_print` only resizes
and pads to the 4500×5400 print canvas — no background removal happens here.

Outputs go to .tmp/print/ as a flat folder (one file per output, easy to scrub):
    <slug>.png       print resized + padded to 4500×5400 (always)
    <slug>-shirt.jpg composite on the white-tee template (when --shirt is set)
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

import httpx
from PIL import Image

from packages.design.image_processor import process_for_print

CANVAS_PX: tuple[int, int] = (1200, 1200)

# Chest paste box in canvas coords. 5:6 aspect mirrors OUTPUT_DIMENSIONS_PX
# (4500×5400) so the scaled print preserves its true on-garment proportions.
# Tuned against the Gildan 64000 white-tee template (scripts/shirt-template.png).
CHEST_BOX: tuple[int, int, int, int] = (430, 360, 770, 768)

IMAGE_EXTS: frozenset[str] = frozenset({".png", ".jpg", ".jpeg", ".webp"})

TEMPLATE_PATH = Path(__file__).resolve().parent / "shirt-template.png"
OUT_ROOT = Path(__file__).resolve().parents[1] / ".tmp" / "print"


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-") or "image"


def _fetch_bytes(src: str) -> bytes:
    if src.startswith(("http://", "https://")):
        r = httpx.get(src, timeout=60, follow_redirects=True)
        r.raise_for_status()
        return r.content
    return Path(src).read_bytes()


def _collect_sources(arg: str) -> list[str]:
    """Expand the CLI arg into a list of image sources (URLs or absolute file paths).

    - URL → single-element list with the URL.
    - File → single-element list with the path.
    - Directory → sorted list of every PNG/JPG/JPEG/WEBP at the top level (non-recursive).
    """
    if arg.startswith(("http://", "https://")):
        return [arg]

    path = Path(arg)
    if not path.exists():
        raise FileNotFoundError(f"not found: {arg}")

    if path.is_file():
        return [str(path)]

    files = sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    if not files:
        raise ValueError(f"no PNG/JPG/JPEG/WEBP files in {path}")
    return [str(p) for p in files]


def _load_template() -> Image.Image:
    """Load the shirt template. Caller must check TEMPLATE_PATH.exists() first."""
    img = Image.open(TEMPLATE_PATH).convert("RGB")
    if img.size != CANVAS_PX:
        img = img.resize(CANVAS_PX, Image.Resampling.LANCZOS)
    return img


def _composite_print(print_bytes: bytes, template: Image.Image) -> Image.Image:
    """Scale the 4500×5400 print to fit CHEST_BOX (aspect-preserving) and alpha-composite."""
    print_img = Image.open(io.BytesIO(print_bytes)).convert("RGBA")
    box_l, box_t, box_r, box_b = CHEST_BOX
    box_w, box_h = box_r - box_l, box_b - box_t
    scale = min(box_w / print_img.width, box_h / print_img.height)
    new_w = round(print_img.width * scale)
    new_h = round(print_img.height * scale)
    resized = print_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    paste_x = box_l + (box_w - new_w) // 2
    paste_y = box_t + (box_h - new_h) // 2
    out = template.convert("RGBA")
    out.alpha_composite(resized, (paste_x, paste_y))
    return out.convert("RGB")


def _process_one(
    src: str,
    *,
    shirt: bool,
    prefix: str,
) -> bool:
    """Process a single source. Returns True on success, False on failure.

    Per-image errors are logged and swallowed at this boundary so a bad file
    in a batch doesn't kill the rest of the run.
    """
    is_url = src.startswith(("http://", "https://"))
    try:
        source_bytes = _fetch_bytes(src)
    except (httpx.HTTPError, OSError) as e:
        print(f"{prefix} failed to load {src}: {e}", file=sys.stderr)
        return False

    stem = "remote" if is_url else Path(src).stem
    slug = _slug(stem)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    print_path = OUT_ROOT / f"{slug}.png"
    print(f"{prefix} {src} ({len(source_bytes) // 1024}KB) → {print_path.name}")

    t0 = time.monotonic()
    try:
        print_bytes = process_for_print(source_bytes)
    except Exception as e:  # noqa: BLE001 — batch boundary: surface + continue
        print(f"{prefix}   process_for_print FAILED: {e}", file=sys.stderr)
        return False

    print_path.write_bytes(print_bytes)
    print(
        f"{prefix}   processed ({len(print_bytes) // 1024}KB) "
        f"in {round((time.monotonic() - t0) * 1000)}ms"
    )

    if shirt:
        template = _load_template()
        composite = _composite_print(print_bytes, template)
        shirt_path = OUT_ROOT / f"{slug}-shirt.jpg"
        composite.save(shirt_path, "JPEG", quality=88, optimize=True)
        print(f"{prefix}   shirt → {shirt_path.name}")

    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source",
        type=str,
        help="Path or URL to a source image, or a folder of images (non-recursive)",
    )
    parser.add_argument(
        "--shirt",
        action="store_true",
        help=(
            "Also write <slug>-shirt.jpg, the print composited onto the white-tee "
            "template at scripts/shirt-template.png."
        ),
    )
    args = parser.parse_args()

    if args.shirt and not TEMPLATE_PATH.exists():
        print(
            f"[print] --shirt requires {TEMPLATE_PATH}; drop a 1200×1200 flat-front PNG there.",
            file=sys.stderr,
        )
        return 2

    try:
        sources = _collect_sources(args.source)
    except (FileNotFoundError, ValueError) as e:
        print(f"[print] {e}", file=sys.stderr)
        return 2

    n = len(sources)
    fails = 0
    t_batch = time.monotonic()
    for i, src in enumerate(sources, 1):
        prefix = f"[print {i}/{n}]" if n > 1 else "[print]"
        if not _process_one(
            src,
            shirt=args.shirt,
            prefix=prefix,
        ):
            fails += 1

    if n > 1:
        elapsed = round(time.monotonic() - t_batch, 1)
        print(f"[print] done — {n - fails}/{n} succeeded in {elapsed}s")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
