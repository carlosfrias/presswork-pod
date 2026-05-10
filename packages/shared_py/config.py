from functools import lru_cache

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

    # fal.ai
    fal_key: str

    # Printify
    printify_api_token: str
    printify_shop_id: str

    # Supabase
    supabase_url: str
    supabase_service_role_key: str

    # Alerts
    resend_api_key: str
    alert_email: str
    slack_webhook_url: str | None = None

    # Runtime
    node_env: str = "development"
    log_level: str = "info"
    human_review_enabled: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
