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
  // 'archived' is an operator-only parking state: the brief was at
  // 'needs_description' and was deferred without deletion. Restorable to
  // 'needs_description' from the Builder page's Archived section.
  status:
    | "needs_review"
    | "needs_description"
    | "approved"
    | "processing"
    | "done"
    | "error"
    | "pending"
    | "archived";
  niche: string;
  style_keywords: string[] | null;
  top_tags: string[] | null;
  price_target_usd: number | null;
  color_palette: string[] | null;
  /** Operator-selected shirt colors to include in this run (e.g. ["White", "Black"]). */
  shirt_colors: string[] | null;
  /** Operator-selected shirt sizes to include in this run (e.g. ["S","M","L","XL","2XL"]). */
  shirt_sizes: string[] | null;
  // Operator-authored image description. Builder writes this; Design's
  // prompt builder folds it into the Claude prompt-build call as
  // authoritative creative direction.
  prompt_constraint: string | null;
  // Renamed from prompt_constraint by migration 045. Holds the
  // operator-authored creative direction fed into the Design agent's
  // FLUX prompt build.
  image_description: string | null;
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
      cost_usd?: number;
    };

export interface DesignPackageRow {
  id: string;
  created_at: string;
  updated_at: string;
  trend_brief_id: string | null;
  status: "needs_review" | "touch_up" | "approved" | "processing" | "done" | "error" | "pending";
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
  /** Running total of fal.ai costs across all regens + re-masks for this design. */
  generation_cost_usd: number;
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
  /**
   * When the operator last pushed local copy edits to Etsy via PATCH.
   * NULL until the first push. Compared to updated_at to know whether
   * there are unpushed changes (migration 047).
   */
  last_pushed_at: string | null;
  /**
   * When the listing's Printify hidden product was last (re)created
   * against the design's image_url. NULL on legacy rows pre-migration 049.
   * Compared to design_packages.updated_at to detect stale artwork on
   * active listings (only). For non-active listings, the migration 049
   * trigger auto-rebuilds — so this column only matters for active rows.
   */
  design_synced_at: string | null;
  /**
   * Variant IDs the operator has explicitly chosen for this listing.
   * When non-null and non-empty, the publisher and preview filter
   * printify_variants to this subset before building Etsy inventory.
   */
  selected_variant_ids: number[] | null;
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
