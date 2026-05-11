import io

import pytest
from PIL import Image

from packages.design.constants import (
    OUTPUT_DIMENSIONS_PX,
    OUTPUT_DPI,
    SCREEN_PRINT_WHITE_HARD,
    SCREEN_PRINT_WHITE_SOFT,
)


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


# --- Screen-print interior-whitespace pass ----------------------------------


def _make_o_shape_png(size: int = 200) -> bytes:
    """Build a synthetic post-rembg "O" — solid black ring with a near-white interior.

    Mimics what rembg returns for a single-color screen-print design: the outer
    background is already transparent, but the *interior* hole of the "O" is
    still opaque white. The screen-print pass should make the interior alpha=0
    while leaving the black ring at alpha=255.
    """
    img = Image.new("RGBA", (size, size), (255, 255, 255, 0))  # transparent canvas
    pixels = img.load()
    assert pixels is not None
    cx, cy = size / 2, size / 2
    outer_r = size * 0.45
    inner_r = size * 0.25
    for y in range(size):
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = (dx * dx + dy * dy) ** 0.5
            if dist <= outer_r and dist >= inner_r:
                pixels[x, y] = (0, 0, 0, 255)  # black ring
            elif dist < inner_r:
                pixels[x, y] = (255, 255, 255, 255)  # opaque white interior
            # else: stay transparent (already initialized)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def mock_rembg_passthrough_o(mocker):
    """rembg passthrough that returns the O-shape fixture unchanged."""
    fixture = _make_o_shape_png()
    return mocker.patch(
        "packages.design.image_processor.rembg_remove",
        side_effect=lambda _png_bytes: fixture,
    )


def _sample_center(img: Image.Image) -> tuple[int, ...]:
    px = img.load()
    assert px is not None
    pixel = px[img.size[0] // 2, img.size[1] // 2]
    assert isinstance(pixel, tuple)
    return pixel


def _sample_ring(img: Image.Image) -> tuple[int, ...]:
    """Sample a pixel that should sit on the black ring at output scale."""
    px = img.load()
    assert px is not None
    # Original interior radius was 25% of width; ring spans 25%-45%. Sample at 35%.
    x = int(img.size[0] * 0.5)
    y = int(img.size[1] * 0.5 - img.size[1] * 0.35)
    pixel = px[x, y]
    assert isinstance(pixel, tuple)
    return pixel


def test_screen_print_strips_interior_white(mock_rembg_passthrough_o):
    from packages.design.image_processor import process_for_print

    png = b"unused"  # rembg is mocked to ignore input
    result = _open_result(process_for_print(png, mode="screen_print"))

    center_alpha = _sample_center(result)[3]
    ring_alpha = _sample_ring(result)[3]
    assert center_alpha == 0, f"interior of O should be transparent, got alpha={center_alpha}"
    assert ring_alpha > 200, f"ink ring should remain opaque, got alpha={ring_alpha}"


def test_full_color_preserves_interior_white(mock_rembg_passthrough_o):
    from packages.design.image_processor import process_for_print

    png = b"unused"
    result = _open_result(process_for_print(png, mode="full_color"))

    center_alpha = _sample_center(result)[3]
    assert center_alpha == 255, (
        f"full_color mode must NOT touch interior whites, got alpha={center_alpha}"
    )


def test_screen_print_edge_softening(mocker):
    """A pixel mid-ramp must land at intermediate alpha — guards against regressing
    to a hard 1-bit threshold (which would jaggy every curved boundary at 4500×5400).
    """
    # Midpoint of the linear ramp: alpha factor should be ~0.5
    mid_luminance = (SCREEN_PRINT_WHITE_HARD + SCREEN_PRINT_WHITE_SOFT) // 2

    # Solid gray PNG at the midpoint luminance. rembg passthrough returns it
    # opaque so the only alpha modulation comes from _strip_interior_whitespace.
    def _fake_remove(_png_bytes: bytes) -> bytes:
        img = Image.new("RGBA", (50, 50), (mid_luminance, mid_luminance, mid_luminance, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    mocker.patch("packages.design.image_processor.rembg_remove", side_effect=_fake_remove)

    from packages.design.image_processor import process_for_print

    result = _open_result(process_for_print(b"unused", mode="screen_print"))
    alpha = _sample_center(result)[3]
    assert 0 < alpha < 255, (
        f"midpoint luminance must produce soft alpha (not 0 or 255), got {alpha}"
    )


def test_screen_print_passes_through_already_transparent_pixels(mock_rembg_passthrough_o):
    """Pixels with alpha=0 from rembg must stay at alpha=0 (the ramp multiplies,
    so 0 * anything = 0). Regression guard against accidentally re-setting alpha.
    """
    from packages.design.image_processor import process_for_print

    result = _open_result(process_for_print(b"unused", mode="screen_print"))
    w, h = result.size
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        assert result.getpixel(corner)[3] == 0
