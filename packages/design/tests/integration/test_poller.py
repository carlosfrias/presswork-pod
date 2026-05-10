import os
import threading

import pytest

from packages.design.poller import claim_next_brief
from supabase import Client, create_client

INTEGRATION = os.getenv("INTEGRATION") == "1"

pytestmark = pytest.mark.skipif(not INTEGRATION, reason="set INTEGRATION=1 to run")

_TEST_NICHE = "poller-integration-test"

_BRIEF_TEMPLATE = {"niche": _TEST_NICHE, "status": "pending"}


@pytest.fixture(scope="module")
def db() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


@pytest.fixture(autouse=True)
def cleanup(db: Client):
    db.table("trend_briefs").delete().eq("niche", _TEST_NICHE).execute()
    yield
    db.table("trend_briefs").delete().eq("niche", _TEST_NICHE).execute()


def _insert_briefs(db: Client, count: int) -> list[str]:
    rows = [dict(_BRIEF_TEMPLATE) for _ in range(count)]
    result = db.table("trend_briefs").insert(rows).execute()
    return [r["id"] for r in result.data]


def test_claim_returns_one_brief_and_flips_status(db: Client):
    ids = _insert_briefs(db, 2)

    first = claim_next_brief(db)
    assert first is not None
    assert str(first.id) in ids
    assert first.status == "processing"

    row = db.table("trend_briefs").select("status").eq("id", str(first.id)).execute()
    assert row.data[0]["status"] == "processing"


def test_claim_drains_all_pending_then_returns_none(db: Client):
    ids = _insert_briefs(db, 2)
    claimed = set()

    b1 = claim_next_brief(db)
    assert b1 is not None
    claimed.add(str(b1.id))

    b2 = claim_next_brief(db)
    assert b2 is not None
    claimed.add(str(b2.id))

    assert claimed == set(ids)

    b3 = claim_next_brief(db)
    assert b3 is None


def test_concurrent_claims_no_duplicates(db: Client):
    _insert_briefs(db, 5)

    results: list = []
    lock = threading.Lock()

    def worker():
        brief = claim_next_brief(db)
        with lock:
            results.append(brief)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    claimed = [r for r in results if r is not None]
    none_count = results.count(None)

    assert len(claimed) == 5
    assert none_count == 5
    assert len({str(b.id) for b in claimed}) == 5, "duplicate claims detected"
