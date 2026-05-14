/**
 * Row shapes used by the dashboard. These mirror the migrations in
 * infra/supabase/migrations/ — when schema changes, update here too.
 */

export interface TrendBriefRow {
  id: string;
  created_at: string;
  updated_at: string;
  // 'needs_description' is the Builder gate: Scout-approved, awaiting an
  // operator-authored image description before Design will claim.
  status:
    | "needs_review"
    | "needs_description"
    | "approved"
    | "processing"
    | "done"
    | "error"
    | "pending";
  niche: string;
  style_keywords: string[] | null;
  top_tags: string[] | null;
  price_target_usd: number | null;
  color_palette: string[] | null;
  // Operator-authored image description. Builder writes this; Design's
  // prompt builder folds it into the Claude prompt-build call as
  // authoritative creative direction.
  prompt_constraint: string | null;
  raw_etsy_data: unknown;
  claude_analysis: unknown;
  error_message: string | null;
  retry_count: number;
}

/**
 * Discriminated union of entries stored in `design_packages.metadata.image_versions`.
 *
 * - `kind: "ai_original" | "hand_edit"` is written by the dashboard's
 *   replace-image flow (operator downloads the AI image, edits it locally,
 *   re-uploads). See `replaceDesignImage` in lib/actions/design.ts.
 * - `kind: "regen"` is appended by the Python Design agent on every successful
 *   full run, and updated in place by the re-mask sweep. Each entry captures
 *   the masked + unmasked pair plus a snapshot of the inputs that produced it
 *   so the operator can step back through history with context.
 */
export type ImageVersion =
  | {
      kind: "ai_original" | "hand_edit";
      url: string;
      uploaded_at: string;
      uploaded_by?: string;
    }
  | {
      kind: "regen";
      masked_url: string;
      unmasked_url: string | null;
      created_at: string;
      prompt: string | null;
      image_model: string | null;
      image_quality: string | null;
      bg_removal_mode: string | null;
      backfilled?: boolean;
      remasked_at?: string;
    };

export interface DesignPackageRow {
  id: string;
  created_at: string;
  updated_at: string;
  trend_brief_id: string | null;
  status: "needs_review" | "approved" | "processing" | "done" | "error" | "pending";
  image_url: string | null;
  // Pre-mask preview — same canvas as image_url but without fal.ai
  // background removal applied. NULL for designs created before migration 026.
  image_url_unmasked: string | null;
  mockup_urls: string[] | null;
  fal_prompt: string | null;
  fal_prompt_hash: string | null;
  printify_blueprint_id: number | null;
  printify_print_provider_id: number | null;
  printify_variant_ids: number[] | null;
  printify_variants: unknown;
  mockups_from_actual_design: boolean;
  metadata: unknown;
  error_message: string | null;
  retry_count: number;
}

export interface ListingRow {
  id: string;
  created_at: string;
  updated_at: string;
  design_package_id: string | null;
  status:
    | "pending"
    | "needs_review"
    | "pending_publish"
    | "publishing"
    | "active"
    | "error";
  etsy_listing_id: number | null;
  printify_product_id: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  price_usd: number | null;
  is_active: boolean;
  error_message: string | null;
  retry_count: number;
}

export interface OrderRow {
  id: string;
  created_at: string;
  updated_at: string;
  etsy_order_id: string;
  listing_id: string | null;
  status: "logged" | "error";
  sale_price: number | null;
  currency_code: string;
  sale_price_usd: number | null;
  print_cost_usd: number | null;
  etsy_fees_usd: number | null;
  margin_usd: number | null;
  buyer_country: string | null;
  error_message: string | null;
  error_log: unknown;
  retry_count: number;
}

export interface DailySummaryRow {
  day: string; // YYYY-MM-DD
  briefs: number;
  designs: number;
  listings_published: number;
  revenue_usd: number;
  margin_usd: number;
  etsy_fees_usd: number;
  order_count: number;
  fal_spend_usd: number;
  anthropic_spend_usd: number;
}

export interface RuntimeFlagRow {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}
