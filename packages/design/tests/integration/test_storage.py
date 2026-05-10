import io
import os
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from packages.design.storage import upload_design
from supabase import Client, create_client

INTEGRATION = os.getenv("INTEGRATION") == "1"

pytestmark = pytest.mark.skipif(not INTEGRATION, reason="set INTEGRATION=1 to run")


@pytest.fixture(scope="module")
def db() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def _small_png() -> bytes:
    img = Image.new("RGBA", (64, 64), (100, 150, 200, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_upload_returns_reachable_url(db: Client):
    design_id = uuid4()
    png_bytes = _small_png()

    try:
        url = upload_design(db, design_id, png_bytes)
        assert url, "URL should be non-empty"

        resp = httpx.get(url)
        assert resp.status_code == 200
        assert "image/png" in resp.headers.get("content-type", "")
    finally:
        db.storage.from_("designs").remove([f"{design_id}.png"])


def test_upsert_same_path_succeeds(db: Client):
    design_id = uuid4()
    png_bytes = _small_png()
    path = f"{design_id}.png"

    try:
        url1 = upload_design(db, design_id, png_bytes)
        url2 = upload_design(db, design_id, png_bytes)
        assert url1 == url2, "Upsert should return the same URL"
    finally:
        db.storage.from_("designs").remove([path])
