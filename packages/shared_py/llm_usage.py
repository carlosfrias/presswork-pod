"""Per-call consumption logging for LLM/image-gen APIs.

Writes one row per call to the `llm_usage` table. Fire-and-forget: failures
never propagate out of `record_usage` so a metrics outage cannot break the
pipeline action that triggered the call.
"""

from __future__ import annotations

from typing import Any, Literal

from .db import get_db
from .logger import get_logger

LlmProvider = Literal["anthropic", "fal", "etsy", "printify"]
LlmAgent = Literal["scout", "design", "listing", "ledger"]

_log = get_logger("shared")


# Per-1M-token pricing for the Claude models this codebase calls. Source:
# https://docs.claude.com/en/docs/about-claude/pricing — refresh when models
# change. Unknown models fall back to Sonnet-4 rates so we still record a
# best-effort number rather than NULL.
ANTHROPIC_PRICING_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    # (input_per_mtok, output_per_mtok)
    "claude-sonnet-4-20250514": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-7": (15.0, 75.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
}

# Per-call USD cost for the fal.ai models the Design agent calls. These are
# *estimates* off fal's published pricing; the authoritative number is the
# remaining-balance delta shown by the dashboard's FalBalanceTile.
FAL_COST_USD: dict[str, float] = {
    "fal-ai/flux-pro/v1.1": 0.05,
    "fal-ai/aura-sr": 0.01,
    # Bria RMBG 2.0 — current background remover. $0.018/call per fal's
    # published rate (55 generations / $1).
    "fal-ai/bria/background/remove": 0.018,
    # Old BiRefNet v2 kept here in case we ever flip back; not on the call
    # path today. Safe to delete after a couple of weeks of stable Bria runs.
    "fal-ai/birefnet/v2": 0.02,
}

# gpt-image-2's bill scales with quality tier × pixel count. These are
# estimates at the 2560×3072 we pin in constants.GPT_IMAGE_DIMENSIONS; refine
# once the fal invoice arrives. (For reference, fal's published table at
# 2560×1440: low $0.007 / medium $0.056 / high $0.222.)
GPT_IMAGE_COST_USD: dict[str, float] = {
    "low": 0.012,
    "medium": 0.080,
    "high": 0.300,
}

# nano-banana-2 (Google Gemini-3 on fal). Base $0.08/image at 1K; resolution
# tiers scale by published multipliers (0.75× at 0.5K, 1.5× at 2K, 2× at 4K).
# We reuse the image_quality column (low|medium|high) and map at the call
# site — see NANO_BANANA_RESOLUTIONS in packages/design/constants.py.
NANO_BANANA_COST_USD: dict[str, float] = {
    "low": 0.06,  # 0.5K
    "medium": 0.08,  # 1K
    "high": 0.12,  # 2K
}


def estimate_anthropic_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
) -> float:
    """Best-effort cost estimate from an Anthropic Messages API response.usage.
    Cache reads are billed at 10% of input rate; cache creation at 125%."""
    input_rate, output_rate = ANTHROPIC_PRICING_USD_PER_MTOK.get(model, (3.0, 15.0))
    return (
        input_tokens * input_rate
        + output_tokens * output_rate
        + cache_read_input_tokens * input_rate * 0.10
        + cache_creation_input_tokens * input_rate * 1.25
    ) / 1_000_000


def fal_cost_usd(model: str) -> float | None:
    return FAL_COST_USD.get(model)


def gpt_image_cost_usd(quality: str) -> float | None:
    return GPT_IMAGE_COST_USD.get(quality)


def nano_banana_cost_usd(quality: str) -> float | None:
    return NANO_BANANA_COST_USD.get(quality)


def record_usage(
    *,
    agent: LlmAgent,
    provider: LlmProvider,
    operation: str,
    cost_usd: float | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    metadata: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Insert one row into `llm_usage`. Swallows all exceptions."""
    try:
        get_db().table("llm_usage").insert(
            {
                "agent": agent,
                "provider": provider,
                "operation": operation,
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "metadata": metadata,
                "error": error,
            }
        ).execute()
    except Exception as exc:  # noqa: BLE001 — metrics path must never raise
        _log.warning(
            "llm_usage_insert_failed",
            provider=provider,
            operation=operation,
            error=str(exc),
        )
