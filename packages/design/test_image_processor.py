import io

import pytest
from PIL import Image

from packages.design.constants import OUTPUT_DIMENSIONS_PX, OUTPUT_DPI


def _make_png(size: tuple[int, int], color: tuple[int, ...], mode: str = "RGBA") -> bytes:
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_transparent_png(size: tuple[int, int], color: tuple[int, int, int, int]) -> bytes:
    """Build an RGBA PNG with transparent corners, simulating rembg output."""
    img = Image.new("RGBA", size, color)
    pixels = img.load()
    assert pixels is not None
    w, h = size
    # Force the four corners to alpha=0 so callers can verify "rembg ran"
    for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        pixels[x, y] = (color[0], color[1], color[2], 0)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _open_result(png_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png_bytes))


@pytest.fixture
def mock_rembg(mocker):
    """Patch rembg.remove to passthrough a transparent-cornered PNG without invoking the model."""
    def _fake_remove(png_bytes: bytes) -> bytes:
        original = Image.open(io.BytesIO(png_bytes))
        return _make_transparent_png(original.size, (200, 100, 50, 255))

    return mocker.patch(
        "packages.design.image_processor.rembg_remove",
        side_effect=_fake_remove,
    )


def test_rembg_is_invoked_exactly_once_with_input_bytes(mock_rembg):
    from packages.design.image_processor import process_for_print

    png = _make_png((100, 100), (255, 255, 255), mode="RGB")
    process_for_print(png)
    assert mock_rembg.call_count == 1
    (called_with,), _ = mock_rembg.call_args
    assert called_with == png


def test_corners_are_transparent_after_processing(mock_rembg):
    from packages.design.image_processor import process_for_print

    png = _make_png((100, 100), (255, 255, 255), mode="RGB")
    result = _open_result(process_for_print(png))
    assert result.mode == "RGBA"
    w, h = result.size
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        assert result.getpixel(corner)[3] == 0, f"Corner {corner} should be transparent"


def test_output_is_exactly_target_dimensions(mock_rembg):
    from packages.design.image_processor import process_for_print

    # Oversized input
    png = _make_png((8000, 8000), (200, 100, 50, 255))
    result = _open_result(process_for_print(png))
    assert result.size == OUTPUT_DIMENSIONS_PX

    # Undersized input
    png = _make_png((100, 100), (200, 100, 50, 255))
    result = _open_result(process_for_print(png))
    assert result.size == OUTPUT_DIMENSIONS_PX


def test_output_dpi_is_300(mock_rembg):
    from packages.design.image_processor import process_for_print

    png = _make_png((500, 500), (200, 100, 50, 255))
    result = _open_result(process_for_print(png))
    dpi = result.info.get("dpi")
    assert dpi is not None, "DPI metadata missing"
    assert dpi[0] == pytest.approx(OUTPUT_DPI, abs=1) and dpi[1] == pytest.approx(OUTPUT_DPI, abs=1)
