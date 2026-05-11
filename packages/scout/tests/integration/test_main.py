import json
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.scout import main
from supabase import create_client

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

_FAKE_LISTINGS = [
    {"title": "Dog Mom Shirt", "tags": ["dog mom"], "price": {"amount": 2499}, "num_reviews": 42}
]

_VALID_ANALYSIS = {
    "niche": "dog mom gifts",
    "style_keywords": ["playful", "illustrated"],
    "top_tags": ["dog mom", "dog lover"],
    "price_target_usd": 24.99,
    "color_palette": ["white", "#3D5AFE"],
}

# 3 seeds so the first run exhausts all of them; second run is fully deduped
_TEST_SEEDS = ["dog mom gifts", "cat lover gifts", "nurse appreciation gifts"]

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
    "PRINTIFY_SHOP_ID": "test",
    "RESEND_API_KEY": "test",
    "ALERT_EMAIL": "test@example.com",
    "SLACK_WEBHOOK_URL": "https://hooks.slack.com/test",
}


@pytest.fixture(autouse=True)
def setup(monkeypatch, mocker):
    for k, v in _ALL_ENV_VARS.items():
        monkeypatch.setenv(k, v)

    from packages.shared_py import config
    from packages.shared_py import db as db_module

    config.get_settings.cache_clear()
    db_module.get_db.cache_clear()

    mocker.patch("packages.scout.main.NICHE_SEEDS", _TEST_SEEDS)

    # Mock Anthropic SDK
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(_VALID_ANALYSIS))]
    anthropic_client = MagicMock()
    anthropic_client.messages.create.return_value = msg
    mocker.patch("packages.scout.analyzer.Anthropic", return_value=anthropic_client)

    # Mock EtsyClient at the Python object level — avoids respx/httpx transport
    # interference with asyncio.to_thread Supabase calls.
    mock_etsy = MagicMock()
    mock_etsy.fetch_top_listings = AsyncMock(return_value=_FAKE_LISTINGS)
    mocker.patch("packages.scout.main.EtsyClient", return_value=mock_etsy)

    yield

    create_client(_SUPABASE_URL, _SUPABASE_KEY).table("trend_briefs").delete().in_(
        "niche", _TEST_SEEDS
    ).execute()


async def test_run_inserts_pending_rows():
    await main.run()

    check = create_client(_SUPABASE_URL, _SUPABASE_KEY)
    rows = check.table("trend_briefs").select("id,niche,status").execute()
    test_rows = [r for r in rows.data if r["niche"] in _TEST_SEEDS]

    assert 3 <= len(test_rows) <= 5
    assert all(r["status"] == "pending" for r in test_rows)


async def test_second_run_inserts_nothing():
    check = create_client(_SUPABASE_URL, _SUPABASE_KEY)

    await main.run()
    after_first = len(check.table("trend_briefs").select("id").execute().data)

    await main.run()
    after_second = len(check.table("trend_briefs").select("id").execute().data)

    assert after_second == after_first
