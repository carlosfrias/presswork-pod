from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

TrendBriefStatus = Literal[
    "pending",
    "needs_review",
    # Scout-approved, waiting for Builder to attach an image description before
    # Design will claim. Set by the Scout-approve action; cleared to 'approved'
    # by Builder's send-to-design action. Skipped when scout_auto_approve_enabled
    # is on (briefs go straight to 'approved' in that mode).
    "needs_description",
    "approved",
    "processing",
    "done",
    "error",
]

# Which fal-hosted image-gen backend the Design agent uses for this brief.
#   fal_flux_pro     → fal-ai/flux-pro/v1.1 (legacy; needs ritual-phrase prompts
#                       + aura-sr upscaler pass).
#   fal_gpt_image_2  → openai/gpt-image-2 (default; follows literal prompts,
#                       native output skips the upscaler).
ImageModel = Literal["fal_flux_pro", "fal_gpt_image_2"]

# gpt-image-2 quality tier. NULL is allowed for FLUX briefs (FLUX ignores it).
ImageQuality = Literal["low", "medium", "high"]


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
    # Optional user-provided image prompt. When set, Design's prompt_builder.py
    # uses this verbatim instead of calling Claude. For fal_flux_pro briefs the
    # FluxPrompt validator still applies; for fal_gpt_image_2 briefs no
    # required-phrase ritual is enforced. Column name preserved across the
    # gpt-image-2 cutover; rename to custom_image_prompt is a follow-up.
    custom_flux_prompt: str | None = None
    # Optional operator hint that gets folded into the Design agent's Claude
    # prompt-build call (or appended to a custom prompt). Distinct from
    # custom_flux_prompt: this *guides* Claude rather than replacing it. Set
    # by the Scout inject form when the operator has a style/composition
    # instinct they want carried through every regen of this brief.
    prompt_constraint: str | None = None
    image_model: ImageModel = "fal_gpt_image_2"
    image_quality: ImageQuality | None = None
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
    custom_flux_prompt: str | None = None
    prompt_constraint: str | None = None
    image_model: ImageModel = "fal_gpt_image_2"
    image_quality: ImageQuality | None = None


DesignPackageStatus = Literal["pending", "needs_review", "approved", "processing", "done", "error"]

FLUX_REQUIRED_TERMS = [
    "print on demand design",
    "vector-style",
]

# FLUX prompts must specify a solid background — white OR black, caller picks
# one. We don't ask FLUX for a transparent background: it can't deliver true
# alpha, and birefnet (the downstream background remover) handles cutout
# cleaner from a solid-color plate anyway. Likewise we don't ask for "high
# resolution" — aura-sr is the dedicated upscaler in the pipeline.
FLUX_REQUIRED_BACKGROUND_TERMS = ("white background", "black background")

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
        if not any(term in lower for term in FLUX_REQUIRED_BACKGROUND_TERMS):
            raise ValueError(
                "Prompt must specify a solid background: one of "
                f"{list(FLUX_REQUIRED_BACKGROUND_TERMS)}"
            )
        return v


class ImagePrompt(BaseModel):
    """Backend-agnostic image prompt. Used by openai/gpt-image-2 (which takes
    natural English) and any future model that doesn't need FLUX's required-
    phrase ritual. No `negative_prompt` field — gpt-image-2's API doesn't
    accept one; negation is folded into the positive prompt.
    """

    prompt: str
    style_descriptors: list[str]


class DesignPackage(BaseModel):
    id: UUID
    created_at: datetime
    updated_at: datetime
    trend_brief_id: UUID | None = None
    status: DesignPackageStatus
    image_url: str | None = None
    # Pre-mask version of the final canvas — same dimensions and padding as
    # image_url, but fal.ai background removal has not been applied. Surfaced
    # on the Design page so the operator can verify the mask cut cleanly.
    image_url_unmasked: str | None = None
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
