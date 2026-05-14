from functools import lru_cache
from typing import Literal

from pydantic import EmailStr, Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # `extra="ignore"` so .env vars owned by the dashboard (NEXT_PUBLIC_*,
    # DASHBOARD_*, etc.) and other non-Python services don't crash the Python
    # agents at boot. We intentionally do not silently accept arbitrary fields
    # via __pydantic_extra__ — they're dropped, not stored.
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

    # Anthropic
    anthropic_api_key: str

    # Etsy
    etsy_api_key: str
    etsy_api_secret: str
    etsy_shop_id: str
    etsy_access_token: str
    etsy_refresh_token: str
    # Etsy POD policy requires production_partner_ids on every listing — the
    # numeric ID Etsy returned when Printify was registered in Shop Manager.
    # Only the TS Listing agent calls Etsy draft create, and it has its own
    # `validateProductionPartnerId` Zod gate. No Python code reads this field,
    # so we keep it optional here — making it required just crashed Scout and
    # Design at boot for a value they don't need.
    etsy_production_partner_id: int | None = Field(default=None, gt=0)
    # Provided by Etsy when the webhook subscription is created (whsec_<base64>).
    # Optional so non-webhook test runs don't fail.
    etsy_webhook_secret: str | None = None

    # fal.ai
    fal_key: str

    # Printify
    printify_api_token: str
    printify_shop_id: str
    # Optional — set to enable webhook-driven order updates (mirrors TS config).
    printify_webhook_base_url: HttpUrl | None = None
    printify_webhook_secret: str | None = Field(default=None, min_length=32)

    # Supabase
    supabase_url: HttpUrl
    supabase_service_role_key: str

    # Alerts. Resend is not yet implemented (notifier.py only sends to Slack),
    # so resend_api_key / alert_email are optional — declaring them as required
    # would crash every agent at boot for a feature that doesn't exist yet.
    resend_api_key: str | None = None
    alert_email: EmailStr | None = None
    slack_webhook_url: HttpUrl | None = None

    # Runtime
    node_env: str = "development"
    log_level: str = "info"
    # Operator kill-switch for the AI upscaler step in the Design agent.
    # On = call fal.ai aura-sr between FLUX and Pillow (real 4× SR, ~$0.01/image).
    # Off = skip the step, fall through to current LANCZOS-only path.
    upscaler_enabled: bool = True
    # Background-removal backend for the Design agent.
    #   "local"    → in-process rembg U²-Net. Free. Current default.
    #   "birefnet" → fal.ai BiRefNet v2 — paid AI fallback for fine edges.
    #   "bria"     → fal.ai Bria RMBG 2.0 — paid AI fallback for flat colors.
    # This is the env default; the runtime_flags row of the same name overrides
    # it per design run via `get_runtime_flag`.
    background_removal_mode: Literal["birefnet", "bria", "local"] = "local"
    # When True, Scout includes Etsy listing thumbnails as image content blocks
    # in the analyzer call. Adds ~3-5× per-run token cost; off by default. Env
    # default; live-overridable via the runtime_flags row of the same name.
    scout_vision_enabled: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
