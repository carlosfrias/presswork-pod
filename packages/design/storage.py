import secrets
from datetime import UTC, datetime
from uuid import UUID

from packages.design.constants import STORAGE_BUCKET
from supabase import Client


def upload_design(
    db: Client,
    design_id: UUID,
    png_bytes: bytes,
    *,
    suffix: str = "",
    versioned: bool = False,
) -> str:
    # `suffix` lets callers stash secondary variants of a design under the
    # same ID — currently only "-unmasked" for the pre-birefnet preview the
    # Design page flips to. Empty suffix preserves the legacy "<id>.png" path
    # so existing rows' URLs stay valid.
    #
    # `versioned=True` mints a unique storage key per upload so successive
    # regens don't overwrite each other — the stack of historical iterations
    # in design_packages.metadata.image_versions points at these immutable
    # objects. The non-versioned default path is preserved for the re-mask
    # sweep, which intentionally overwrites the current image_url in place.
    if versioned:
        ts = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
        rand = secrets.token_hex(3)
        path = f"{design_id}-{ts}-{rand}{suffix}.png"
    else:
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
