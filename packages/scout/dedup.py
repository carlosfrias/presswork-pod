import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from anthropic import Anthropic
from pydantic import BaseModel

from packages.shared_py.config import get_settings
from supabase import Client


async def is_recent_duplicate(niche: str, db: Client) -> bool:
    cutoff = (datetime.now(UTC) - timedelta(days=7)).isoformat()

    def _query() -> bool:
        result = (
            db.table("trend_briefs")
            .select("id")
            .eq("niche", niche)
            .gte("created_at", cutoff)
            .limit(1)
            .execute()
        )
        return len(result.data) > 0

    return await asyncio.to_thread(_query)


class _SemanticDupResult(BaseModel):
    is_duplicate: bool
    matched_niche: str | None = None


_SEMANTIC_SYSTEM = (
    "Given a candidate niche and a list of recent niches with their style keywords, "
    "return JSON {\"is_duplicate\": bool, \"matched_niche\": str | null}. "
    "A match means the candidate would produce overlapping designs."
)


async def is_semantic_duplicate(niche: str, db: Client) -> tuple[bool, str | None]:
    cutoff = (datetime.now(UTC) - timedelta(days=7)).isoformat()

    def _fetch_recent() -> list[dict[str, Any]]:
        result = (
            db.table("trend_briefs")
            .select("niche,style_keywords")
            .gte("created_at", cutoff)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        return [cast(dict[str, Any], row) for row in result.data]

    recent = await asyncio.to_thread(_fetch_recent)

    if not recent:
        return False, None

    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    user_content = json.dumps(
        {
            "candidate_niche": niche,
            "recent_niches": [
                {"niche": row.get("niche"), "style_keywords": row.get("style_keywords")}
                for row in recent
            ],
        },
        indent=2,
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=256,
        system=[
            {
                "type": "text",
                "text": _SEMANTIC_SYSTEM,
                "cache_control": {"type": "ephemeral"},  # type: ignore[typeddict-unknown-key]
            }
        ],
        messages=[{"role": "user", "content": user_content}],
    )

    first_block = response.content[0]
    if first_block.type != "text":
        return False, None

    try:
        parsed = _SemanticDupResult.model_validate_json(first_block.text)
    except Exception:
        return False, None

    return parsed.is_duplicate, parsed.matched_niche
