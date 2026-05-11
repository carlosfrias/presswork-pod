import io
from typing import Literal

import numpy as np
from PIL import Image
from rembg import remove as rembg_remove

from packages.design.constants import (
    OUTPUT_DIMENSIONS_PX,
    OUTPUT_DPI,
    SCREEN_PRINT_WHITE_HARD,
    SCREEN_PRINT_WHITE_SOFT,
)

PrintMode = Literal["full_color", "screen_print"]


def _resize_with_padding(img: Image.Image, target: tuple[int, int]) -> Image.Image:
    """Resize preserving aspect ratio (up or down), pad transparent borders to reach target."""
    target_w, target_h = target
    scale = min(target_w / img.width, target_h / img.height)
    new_w = round(img.width * scale)
    new_h = round(img.height * scale)
    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", target, (0, 0, 0, 0))
    canvas.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2))
    return canvas


def _strip_interior_whitespace(img: Image.Image) -> Image.Image:
    """Multiply alpha by a luminance ramp so near-white pixels become transparent.

    rembg removes the exterior background but leaves interior negative space
    (e.g. the hole inside an "O") opaque. For a one-ink-color screen print
    that interior must also be transparent so the shirt color shows through.

    Per-pixel: compute luminance L = 0.2126·R + 0.7152·G + 0.0722·B. Pixels with
    L >= WHITE_HARD have alpha multiplied by 0; L <= WHITE_SOFT keep their
    original alpha; in between, alpha is multiplied by a linear factor in
    [0.0, 1.0]. The ramp preserves anti-aliasing on curved boundaries.
    """
    arr = np.asarray(img, dtype=np.float32)
    rgb = arr[..., :3]
    alpha = arr[..., 3]

    luminance = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]

    span = float(SCREEN_PRINT_WHITE_HARD - SCREEN_PRINT_WHITE_SOFT)
    # 1.0 below the soft threshold, 0.0 at/above the hard threshold, linear ramp between.
    factor = np.clip((SCREEN_PRINT_WHITE_HARD - luminance) / span, 0.0, 1.0)

    new_alpha = alpha * factor
    out = arr.copy()
    out[..., 3] = new_alpha
    return Image.fromarray(out.astype(np.uint8), mode="RGBA")


def process_for_print(png_bytes: bytes, *, mode: PrintMode = "full_color") -> bytes:
    # screen_print is opt-in and known-rough. rembg gives us the bounding
    # silhouette but does not poke holes in interior negative space, and the
    # luminance-ramp strip below is tuned for FLUX outputs only — non-FLUX
    # sources (e.g. JPG line art, photo references) won't dial in cleanly at
    # the current thresholds and may leave gray halos around the figure.
    # Revisit post-v1 if/when we add a true line-art ingestion path.
    #
    # rembg first: FLUX cannot produce true alpha transparency, so every image gets
    # background removal regardless of how clean it looks. Must run before resize/DPI
    # so the U²-Net model sees the original pixels.
    transparent_bytes = rembg_remove(png_bytes)
    img = Image.open(io.BytesIO(transparent_bytes)).convert("RGBA")

    if mode == "screen_print":
        # Run the interior-whitespace strip BEFORE resize so LANCZOS over the
        # softened alpha mask produces cleaner ramps than the reverse order.
        img = _strip_interior_whitespace(img)

    img = _resize_with_padding(img, OUTPUT_DIMENSIONS_PX)

    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(OUTPUT_DPI, OUTPUT_DPI))
    return buf.getvalue()
