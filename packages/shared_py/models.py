from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

TrendBriefStatus = Literal["pending", "processing", "done", "error"]


class TrendBrief(BaseModel):
    id: UUID
    created_at: datetime
    updated_at: datetime
    status: TrendBriefStatus
    niche: str
    style_keywords: list[str] | None = None
    top_tags: list[str] | None = None
    price_target_usd: float | None = None
    color_palette: list[str] | None = None
    raw_etsy_data: Any | None = None
    claude_analysis: Any | None = None
    error_message: str | None = None
    retry_count: int = 0


class TrendBriefCreate(BaseModel):
    niche: str
    status: TrendBriefStatus = "pending"
    style_keywords: list[str] | None = None
    top_tags: list[str] | None = None
    price_target_usd: float | None = None
    color_palette: list[str] | None = None
    raw_etsy_data: Any | None = None
    claude_analysis: Any | None = None


DesignPackageStatus = Literal["pending", "processing", "done", "error"]

FLUX_REQUIRED_TERMS = [
    "print on demand design",
    "transparent background",
    "high resolution",
    "vector-style",
]

# Trademark/IP protection lives upstream (the copywriter system prompt in
# packages/listing/src/copywriter.ts forbids names of artists, brands, living
# people, and copyrighted characters) and downstream (validateCopyCompliance in
# packages/listing/src/compliance.ts). A 5-name substring blocklist on the FLUX
# prompt was theater — anything slightly creative would slip through it and a
# substring match could over-trigger on legitimate words. Removed.


class FluxPrompt(BaseModel):
    prompt: str
    negative_prompt: str | None = None
    style_descriptors: list[str]

    @field_validator("prompt")
    @classmethod
    def required_flux_terms(cls, v: str) -> str:
        lower = v.lower()
        for term in FLUX_REQUIRED_TERMS:
            if term not in lower:
                raise ValueError(f"Prompt must contain required FLUX term: '{term}'")
        return v


class DesignPackage(BaseModel):
    id: UUID
    created_at: datetime
    updated_at: datetime
    trend_brief_id: UUID | None = None
    status: DesignPackageStatus
    image_url: str | None = None
    mockup_urls: list[str] | None = None
    # True iff mockup_urls came from a Printify product built on top of image_url.
    # Etsy image policy: listing images must be of the actual design — never generic
    # stock or unrelated lifestyle shots. Listing Agent flips this to True when it
    # writes the Printify-generated mockup URLs back to this row.
    mockups_from_actual_design: bool = False
    printify_blueprint_id: int | None = None
    printify_print_provider_id: int | None = None
    printify_variant_ids: list[int] | None = None
    fal_prompt: str | None = None
    fal_prompt_hash: str | None = None
    metadata: Any | None = None
    error_message: str | None = None
    retry_count: int = 0


class DesignPackageCreate(BaseModel):
    trend_brief_id: UUID
    status: DesignPackageStatus = "pending"
    image_url: str | None = None
    mockup_urls: list[str] | None = None
    mockups_from_actual_design: bool = False
    printify_blueprint_id: int | None = None
    printify_print_provider_id: int | None = None
    printify_variant_ids: list[int] | None = None
    fal_prompt: str | None = None
    metadata: Any | None = None


ListingStatus = Literal[
    "pending", "needs_review", "pending_publish", "publishing", "active", "error"
]


class Listing(BaseModel):
    id: UUID
    created_at: datetime
    updated_at: datetime
    design_package_id: UUID | None = None
    status: ListingStatus
    etsy_listing_id: int | None = None
    printify_product_id: str | None = None
    title: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    price_usd: float | None = None
    is_active: bool = False
    error_message: str | None = None
    retry_count: int = 0


class ClaudeAnalysis(BaseModel):
    niche: str
    style_keywords: list[str]
    top_tags: list[str] = Field(..., max_length=13)
    price_target_usd: float
    color_palette: list[str]

    @field_validator("top_tags")
    @classmethod
    def max_13_tags(cls, v: list[str]) -> list[str]:
        if len(v) > 13:
            raise ValueError(f"top_tags must have at most 13 items, got {len(v)}")
        return v
