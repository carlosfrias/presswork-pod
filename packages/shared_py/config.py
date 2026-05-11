from functools import lru_cache

from pydantic import EmailStr, Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

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
    # Mirrors the TS-side `ETSY_PRODUCTION_PARTNER_ID` requirement so the Python
    # agents fail fast at boot instead of silently passing None into a draft.
    etsy_production_partner_id: int = Field(..., gt=0)
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

    # Alerts
    resend_api_key: str
    alert_email: EmailStr
    slack_webhook_url: HttpUrl | None = None

    # Runtime
    node_env: str = "development"
    log_level: str = "info"
    human_review_enabled: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
