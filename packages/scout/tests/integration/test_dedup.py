import os
from datetime import UTC, datetime, timedelta

import pytest

from packages.scout.dedup import is_recent_duplicate
from supabase import Client, create_client

INTEGRATION = os.getenv("INTEGRATION") == "1"

pytestmark = [
    pytest.mark.skipif(not INTEGRATION, reason="set INTEGRATION=1 to run"),
    pytest.mark.asyncio,
]

_TEST_NICHES = ["cats", "dogs"]


@pytest.fixture(scope="module")
def db() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


@pytest.fixture(autouse=True)
def cleanup(db: Client):
    # Wipe test rows before and after each test so they don't bleed across
    db.table("trend_briefs").delete().in_("niche", _TEST_NICHES).execute()
    yield
    db.table("trend_briefs").delete().in_("niche", _TEST_NICHES).execute()


async def test_recent_entry_is_duplicate(db: Client):
    db.table("trend_briefs").insert({"niche": "cats", "status": "pending"}).execute()
    assert await is_recent_duplicate("cats", db) is True


async def test_unseen_niche_is_not_duplicate(db: Client):
    assert await is_recent_duplicate("dogs", db) is False


async def test_entry_older_than_7_days_is_not_duplicate(db: Client):
    eight_days_ago = (datetime.now(UTC) - timedelta(days=8)).isoformat()
    db.table("trend_briefs").insert(
        {"niche": "cats", "status": "pending", "created_at": eight_days_ago}
    ).execute()
    assert await is_recent_duplicate("cats", db) is False
