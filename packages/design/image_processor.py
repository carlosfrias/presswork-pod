import io

from PIL import Image

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
    """Resize + pad the input PNG to the print canvas at OUTPUT_DPI.

    Caller is responsible for delivering a transparent RGBA PNG. Background
    removal lives upstream as a fal.ai call (birefnet or bria), so this stage
    no longer runs any local segmentation, matte-decontamination, or alpha
    cleanup — those passes were tuned for rembg and are unnecessary now that
    fal handles the cutout.
    """
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    img = _resize_with_padding(img, OUTPUT_DIMENSIONS_PX)
    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(OUTPUT_DPI, OUTPUT_DPI))
    return buf.getvalue()
