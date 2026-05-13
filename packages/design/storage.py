from uuid import UUID

from packages.design.constants import STORAGE_BUCKET
from supabase import Client


def upload_design(
    db: Client,
    design_id: UUID,
    png_bytes: bytes,
    *,
    suffix: str = "",
) -> str:
    # `suffix` lets callers stash secondary variants of a design under the
    # same ID — currently only "-unmasked" for the pre-birefnet preview the
    # Design page flips to. Empty suffix preserves the legacy "<id>.png" path
    # so existing rows' URLs stay valid.
    path = f"{design_id}{suffix}.png"

    db.storage.from_(STORAGE_BUCKET).upload(
        path,
        png_bytes,
        file_options={"content-type": "image/png", "upsert": "true"},
    )

    url: str = db.storage.from_(STORAGE_BUCKET).get_public_url(path)
    if not url:
        raise RuntimeError(f"Storage upload succeeded but returned empty URL for path: {path}")
    return url
