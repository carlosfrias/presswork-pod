import io

from PIL import Image
from rembg import remove as rembg_remove

from packages.design.constants import OUTPUT_DIMENSIONS_PX, OUTPUT_DPI


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
    # rembg first: FLUX cannot produce true alpha transparency, so every image gets
    # background removal regardless of how clean it looks. Must run before resize/DPI
    # so the U²-Net model sees the original pixels.
    transparent_bytes = rembg_remove(png_bytes)
    img = Image.open(io.BytesIO(transparent_bytes)).convert("RGBA")

    img = _resize_with_padding(img, OUTPUT_DIMENSIONS_PX)

    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(OUTPUT_DPI, OUTPUT_DPI))
    return buf.getvalue()
