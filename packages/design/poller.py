from typing import Any, cast

from packages.shared_py.models import TrendBrief
from supabase import Client


def claim_next_brief(db: Client) -> TrendBrief | None:
    result = db.rpc("claim_pending_trend_brief").execute()
    if not result.data:
        return None
    return TrendBrief.model_validate(cast(dict[str, Any], result.data[0]))
