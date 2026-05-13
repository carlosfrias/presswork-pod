import io
import json
import os
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx
from PIL import Image

from packages.design import main as design_main
from supabase import Client, create_client

INTEGRATION = os.getenv("INTEGRATION") == "1"

pytestmark = [
    pytest.mark.skipif(not INTEGRATION, reason="set INTEGRATION=1 to run"),
    pytest.mark.asyncio,
]

_SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
_SUPABASE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
)

_TEST_NICHE = "main-integration-test-niche"

_VALID_FLUX_PROMPT = {
    "prompt": "print on demand design, vector-style mountain, white background",
    "negative_prompt": "blurry",
    "style_descriptors": ["minimalist", "nature"],
}

_FAKE_IMAGE_URL = "https://cdn.fal.ai/images/fake-design.png"

_ALL_ENV_VARS = {
    "SUPABASE_URL": _SUPABASE_URL,
    "SUPABASE_SERVICE_ROLE_KEY": _SUPABASE_KEY,
    "ANTHROPIC_API_KEY": "test",
    "ETSY_API_KEY": "test",
    "ETSY_API_SECRET": "test",
    "ETSY_SHOP_ID": "test",
    "ETSY_ACCESS_TOKEN": "test",
    "ETSY_REFRESH_TOKEN": "test",
    "FAL_KEY": "test",
    "PRINTIFY_API_TOKEN": "test",
    "PRINTIFY_SHOP_ID": "test-shop",
    "RESEND_API_KEY": "test",
    "ALERT_EMAIL": "test@example.com",
    "SLACK_WEBHOOK_URL": "https://hooks.slack.com/test",
}


def _small_png_bytes() -> bytes:
    img = Image.new("RGBA", (64, 64), (100, 150, 200, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_client() -> Client:
    return create_client(_SUPABASE_URL, _SUPABASE_KEY)


@pytest.fixture()
def db() -> Client:
    return _make_client()


@pytest.fixture(autouse=True)
def setup_env(monkeypatch, mocker):
    for k, v in _ALL_ENV_VARS.items():
        monkeypatch.setenv(k, v)

    from packages.shared_py import config
    from packages.shared_py import db as db_module

    config.get_settings.cache_clear()
    db_module._reset_db_client()

    yield

    _make_client().table("trend_briefs").delete().eq("niche", _TEST_NICHE).execute()
    _make_client().table("design_packages").delete().eq("status", "done").execute()


def _mock_anthropic(mocker):
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(_VALID_FLUX_PROMPT))]
    client = MagicMock()
    client.messages.create.return_value = msg
    mocker.patch("packages.design.prompt_builder.Anthropic", return_value=client)
    return client


def _mock_fal(mocker):
    """Mock every fal stage. FLUX (generate_image_url), aura-sr (upscale_url),
    and birefnet (remove_background_birefnet_url) all return the same fake URL
    so the integration test exercises the URL-threading path without hitting
    fal.ai. The single download_image call at the end pulls _small_png_bytes
    from respx so process_for_print has something to work with."""
    flux_mock = AsyncMock(return_value=_FAKE_IMAGE_URL)
    upscale_mock = AsyncMock(return_value=_FAKE_IMAGE_URL)
    birefnet_mock = AsyncMock(return_value=_FAKE_IMAGE_URL)
    mocker.patch("packages.design.main.generate_image_url", flux_mock)
    mocker.patch("packages.design.main.upscale_url", upscale_mock)
    mocker.patch("packages.design.main.remove_background_birefnet_url", birefnet_mock)
    return flux_mock


def _insert_brief(db: Client) -> str:
    result = (
        db.table("trend_briefs")
        .insert(
            {
                "niche": _TEST_NICHE,
                "status": "pending",
                "style_keywords": ["minimalist", "nature"],
                "color_palette": ["green", "cream"],
                "top_tags": ["hiking", "outdoors"],
            }
        )
        .execute()
    )
    return result.data[0]["id"]


@respx.mock
async def test_happy_path_creates_done_design_package(db: Client, mocker):
    _mock_anthropic(mocker)
    _mock_fal(mocker)
    respx.get(_FAKE_IMAGE_URL).mock(return_value=httpx.Response(200, content=_small_png_bytes()))

    brief_id = _insert_brief(db)

    await design_main.run()

    pkg = db.table("design_packages").select("*").eq("trend_brief_id", brief_id).execute()
    assert len(pkg.data) == 1
    assert pkg.data[0]["status"] == "done"
    assert pkg.data[0]["image_url"]

    brief = db.table("trend_briefs").select("status").eq("id", brief_id).execute()
    assert brief.data[0]["status"] == "done"


@respx.mock
async def test_retryable_failure_flips_back_to_pending(db: Client, mocker):
    _mock_anthropic(mocker)
    mocker.patch(
        "packages.design.main.generate_image_url",
        new=AsyncMock(side_effect=RuntimeError("fal.ai down")),
    )

    brief_id = _insert_brief(db)
    await design_main.run()

    brief = db.table("trend_briefs").select("status,retry_count").eq("id", brief_id).execute()
    assert brief.data[0]["retry_count"] == 1
    assert brief.data[0]["status"] == "pending"


@respx.mock
async def test_exhausted_retries_leave_row_in_error(db: Client, mocker):
    _mock_anthropic(mocker)
    mocker.patch(
        "packages.design.main.generate_image_url",
        new=AsyncMock(side_effect=RuntimeError("fal.ai down")),
    )

    db.table("trend_briefs").insert(
        {
            "niche": _TEST_NICHE,
            "status": "pending",
            "retry_count": 2,
        }
    ).execute()

    await design_main.run()

    rows = db.table("trend_briefs").select("status,retry_count").eq("niche", _TEST_NICHE).execute()
    row = rows.data[0]
    assert row["status"] == "error"
    assert row["retry_count"] == 3
