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
#   fal_flux_pro       → fal-ai/flux-pro/v1.1 (legacy; needs ritual-phrase
#                         prompts + aura-sr upscaler pass).
#   fal_gpt_image_2    → openai/gpt-image-2 (default; follows literal prompts,
#                         native output skips the upscaler).
#   fal_nano_banana_2  → fal-ai/nano-banana-2 (Google Gemini-3 on fal; natural
#                         English prompts, strong with text/typography and
#                         multi-subject consistency, $0.08/image at 1K).
ImageModel = Literal["fal_flux_pro", "fal_gpt_image_2", "fal_nano_banana_2"]

# Quality tier — meaning depends on the backend:
#   gpt-image-2     → openai's low/medium/high quality flag
#   nano-banana-2   → mapped to resolution 0.5K/1K/2K (see NANO_BANANA_RESOLUTIONS)
#   FLUX            → ignored (FLUX has no quality tier; column stays NULL)
ImageQuality = Literal["low", "medium", "high"]

# Background-removal backend override. NULL on the brief = "fall back to
# runtime_flags.background_removal_mode" (currently "local"). Non-NULL pins
# this brief to one cutout backend regardless of the flag, which matters
# when the operator regenerates a design because local rembg's matter is
# failing on this particular subject and they want to spend $0.02 on a fal
# AI cutout instead.
#   local    → in-process rembg U²-Net. Free. The global default.
#   birefnet → fal-ai/birefnet/v2. Paid. Best for fine edges (hair/wisps).
#   bria     → fal-ai/bria/background/remove. Paid. Cleaner on flat colors.
BackgroundRemovalMode = Literal["birefnet", "bria", "local"]


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
    # Builder/operator-authored image description. Used verbatim by Design's
    # prompt_builder for all three backends (FLUX Pro 1.1, gpt-image-2,
    # nano-banana-2) — no model-specific phrase ritual. Print-readiness
    # clauses (palette, framing, background, singular subject) are appended
    # at preprocessing time; this column carries the creative direction.
    image_description: str | None = None
    # Legacy operator hint, was previously merged into the Design prompt as a
    # trailing "Operator instruction (must follow):" override. The trailing
    # append was removed in the 2026-05-14 refactor because it stacked on top
    # of operator edits on regen-with-edit. Still passed to the legacy Claude
    # synthesis path (build_flux_prompt's fallback for briefs where
    # image_description is null) for backward compatibility with old rows.
    # New writes from Builder go to image_description instead.
    prompt_constraint: str | None = None
    image_model: ImageModel = "fal_gpt_image_2"
    image_quality: ImageQuality | None = None
    background_removal_mode: BackgroundRemovalMode | None = None
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
    image_description: str | None = None
    prompt_constraint: str | None = None
    image_model: ImageModel = "fal_gpt_image_2"
    image_quality: ImageQuality | None = None
    background_removal_mode: BackgroundRemovalMode | None = None


DesignPackageStatus = Literal["pending", "needs_review", "approved", "processing", "done", "error"]

# Trademark/IP protection lives upstream (the copywriter system prompt in
# packages/listing/src/copywriter.ts forbids names of artists, brands, living
# people, and copyrighted characters) and downstream (validateCopyCompliance in
# packages/listing/src/compliance.ts). A 5-name substring blocklist on the
# image prompt was theater — anything slightly creative would slip through it
# and a substring match could over-trigger on legitimate words. Removed.


class FluxPrompt(BaseModel):
    """FLUX Pro 1.1 image prompt. The historical FLUX_REQUIRED_TERMS validator
    ("print on demand design", "vector-style", solid bg) was removed in the
    2026-05-14 cleanup — FLUX Pro 1.1 produces good results without those
    incantations, and the solid-background requirement is now enforced
    universally by _preprocess_custom_prompt's BACKGROUND_CLAUSE. Distinct
    from ImagePrompt only by the optional negative_prompt field FLUX accepts.
    """

    prompt: str
    negative_prompt: str | None = None
    style_descriptors: list[str]


class ImagePrompt(BaseModel):
    """Backend-agnostic image prompt. Used by openai/gpt-image-2 and
    nano-banana-2, both of which take natural English. No `negative_prompt`
    field — neither API accepts one; negation is folded into the positive
    prompt.
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
