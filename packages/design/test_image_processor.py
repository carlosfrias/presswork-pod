import io

import pytest
from PIL import Image

from packages.design.constants import OUTPUT_DIMENSIONS_PX, OUTPUT_DPI
from packages.design.image_processor import process_for_print


def _make_png(
    size: tuple[int, int],
    color: tuple[int, ...],
    mode: str = "RGBA",
) -> bytes:
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _open_result(png_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png_bytes))


def test_output_is_exactly_target_dimensions():
    # Oversized input
    big = _make_png((8000, 8000), (200, 100, 50, 255))
    assert _open_result(process_for_print(big)).size == OUTPUT_DIMENSIONS_PX

    # Undersized input
    small = _make_png((100, 100), (200, 100, 50, 255))
    assert _open_result(process_for_print(small)).size == OUTPUT_DIMENSIONS_PX


def test_output_dpi_is_300():
    png = _make_png((500, 500), (200, 100, 50, 255))
    result = _open_result(process_for_print(png))
    dpi = result.info.get("dpi")
    assert dpi is not None, "DPI metadata missing"
    assert dpi[0] == pytest.approx(OUTPUT_DPI, abs=1)
    assert dpi[1] == pytest.approx(OUTPUT_DPI, abs=1)


def test_input_alpha_is_preserved():
    # A transparent-cornered PNG (the shape fal.ai birefnet returns) must
    # come out the other side with the same alpha pattern — process_for_print
    # only resizes/pads, it doesn't touch alpha.
    img = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    for x in range(20, 80):
        for y in range(20, 80):
            img.putpixel((x, y), (10, 200, 80, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    result = _open_result(process_for_print(buf.getvalue()))
    assert result.size == OUTPUT_DIMENSIONS_PX

    cx, cy = result.size[0] // 2, result.size[1] // 2
    pixel = result.getpixel((cx, cy))
    assert isinstance(pixel, tuple), "expected RGBA tuple from RGBA image"
    r, g, b, a = pixel
    assert (r, g, b) == (10, 200, 80)
    assert a == 255, "opaque interior alpha must survive resize/pad"
    # Corners must stay transparent.
    assert result.getpixel((0, 0))[3] == 0


def test_rgb_input_is_converted_to_rgba():
    # PIL needs RGBA for the print canvas; an RGB input should be promoted.
    png = _make_png((200, 200), (255, 0, 0), mode="RGB")
    result = _open_result(process_for_print(png))
    assert result.mode == "RGBA"
