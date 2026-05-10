import io
from typing import cast

from PIL import Image

from packages.design.constants import OUTPUT_DIMENSIONS_PX, OUTPUT_DPI

# Pixels within this distance from pure white (255,255,255) are treated as background.
# Threshold of 15 catches near-white without eating into light-colored design elements.
_WHITE_THRESHOLD = 15


def _is_near_white(pixel: tuple[int, ...]) -> bool:
    r, g, b = pixel[:3]
    return r >= 255 - _WHITE_THRESHOLD and g >= 255 - _WHITE_THRESHOLD and b >= 255 - _WHITE_THRESHOLD


def _remove_white_background(img: Image.Image) -> Image.Image:
    """Make near-white corner-sampled background transparent."""
    rgba = img.convert("RGBA")
    width, height = rgba.size

    # Sample the four corners to decide if this image has a white background
    corners = [
        cast(tuple[int, ...], rgba.getpixel((0, 0))),
        cast(tuple[int, ...], rgba.getpixel((width - 1, 0))),
        cast(tuple[int, ...], rgba.getpixel((0, height - 1))),
        cast(tuple[int, ...], rgba.getpixel((width - 1, height - 1))),
    ]
    if not any(_is_near_white(c) for c in corners):
        return rgba

    data = rgba.load()
    assert data is not None
    for y in range(height):
        for x in range(width):
            pixel = cast(tuple[int, ...], data[x, y])
            if _is_near_white(pixel):
                data[x, y] = (pixel[0], pixel[1], pixel[2], 0)
    return rgba


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


def process_for_print(png_bytes: bytes) -> bytes:
    img = Image.open(io.BytesIO(png_bytes))

    if img.mode != "RGBA":
        img = img.convert("RGBA")

    img = _remove_white_background(img)
    img = _resize_with_padding(img, OUTPUT_DIMENSIONS_PX)

    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(OUTPUT_DPI, OUTPUT_DPI))
    return buf.getvalue()
