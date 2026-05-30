import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { STYLE_IDS, type StyleId } from "@/lib/styles/catalog";
import {
  IMAGE_MODEL_IDS,
  type ImageModelId,
} from "@/lib/models/image-models";
import {
  BG_REMOVAL_IDS,
  type BgRemovalModeId,
} from "@/lib/models/bg-removal";
import type {
  DesignPackageRow,
  ImageVersion,
  TrendBriefRow,
} from "./types";

export interface DesignReviewItem extends DesignPackageRow {
  /**
   * Newest-last array of `kind: "regen"` entries from
   * `metadata.image_versions`. Filtered + narrowed server-side so the review
   * card never has to reach into the unknown `metadata` JSON. Empty array
   * for designs created before the stack feature shipped (the next regen
   * backfills the prior pair as the first entry).
   */
  regen_stack: Extract<ImageVersion, { kind: "regen" }>[];
  trend_brief:
    | (Pick<TrendBriefRow, "id" | "niche" | "color_palette"> & {
        // Pulled from trend_briefs.claude_analysis->>'style' so the
        // DesignReviewCard's style picker can reflect the operator's
        // original Builder choice instead of always defaulting to Auto.
        // Null when the brief was created before this field existed, or
        // when the operator explicitly chose Auto.
        style: StyleId | null;
        // Current image-generation backend for this brief — surfaced so the
        // Design regen picker shows the same chip the brief was created with
        // (or last regenerated under).
        image_model: ImageModelId;
        // Per-brief background-removal override; null = "use global flag".
        background_removal_mode: BgRemovalModeId | null;
        // Operator-authored creative direction (renamed by migration 045).
        // Displayed in the review card as context alongside the fal_prompt.
        image_description: string | null;
      })
    | null;
}

// Narrow the unknown JSONB shape down to a StyleId we trust. Guards against
// legacy briefs storing arbitrary strings under .style and stale style ids
// we removed from the catalog.
function extractStyle(analysis: unknown): StyleId | null {
  if (!analysis || typeof analysis !== "object") return null;
  const raw = (analysis as Record<string, unknown>).style;
  if (typeof raw !== "string") return null;
  return (STYLE_IDS as readonly string[]).includes(raw)
    ? (raw as StyleId)
    : null;
}

function narrowImageModel(raw: unknown): ImageModelId {
  if (typeof raw === "string" && (IMAGE_MODEL_IDS as readonly string[]).includes(raw)) {
    return raw as ImageModelId;
  }
  return "fal_gpt_image_2";
}

function narrowBgRemoval(raw: unknown): BgRemovalModeId | null {
  if (typeof raw !== "string") return null;
  return (BG_REMOVAL_IDS as readonly string[]).includes(raw)
    ? (raw as BgRemovalModeId)
    : null;
}

type RegenVersion = Extract<ImageVersion, { kind: "regen" }>;

function isRegenVersion(v: unknown): v is RegenVersion {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "regen" &&
    typeof o.masked_url === "string" &&
    (o.unmasked_url === null || typeof o.unmasked_url === "string")
  );
}

export function extractRegenStack(metadata: unknown): RegenVersion[] {
  if (!metadata || typeof metadata !== "object") return [];
  const versions = (metadata as Record<string, unknown>).image_versions;
  if (!Array.isArray(versions)) return [];
  return versions.filter(isRegenVersion);
}

export async function getDesignReviewQueue(): Promise<DesignReviewItem[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("design_packages")
    .select(
      `*,
       trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(id, niche, color_palette, claude_analysis, image_model, background_removal_mode, image_description)`,
    )
    .eq("status", "needs_review")
    .order("created_at", { ascending: false });
  if (error || !data) {
    console.error("getDesignReviewQueue failed", error);
    return [];
  }
  type Row = DesignPackageRow & {
    trend_briefs:
      | (Pick<TrendBriefRow, "id" | "niche" | "color_palette"> & {
          claude_analysis: unknown;
          image_model: unknown;
          background_removal_mode: unknown;
          image_description: string | null;
        })
      | null;
  };
  return (data as Row[]).map((r) => ({
    ...r,
    regen_stack: extractRegenStack(r.metadata),
    trend_brief: r.trend_briefs
      ? {
          id: r.trend_briefs.id,
          niche: r.trend_briefs.niche,
          color_palette: r.trend_briefs.color_palette,
          style: extractStyle(r.trend_briefs.claude_analysis),
          image_model: narrowImageModel(r.trend_briefs.image_model),
          background_removal_mode: narrowBgRemoval(
            r.trend_briefs.background_removal_mode,
          ),
          image_description: r.trend_briefs.image_description ?? null,
        }
      : null,
  }));
}

export async function getTouchUpQueue(): Promise<DesignReviewItem[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("design_packages")
    .select(
      `*,
       trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(id, niche, color_palette, claude_analysis, image_model, background_removal_mode, image_description)`,
    )
    .eq("status", "touch_up")
    .order("created_at", { ascending: false });
  if (error || !data) {
    console.error("getTouchUpQueue failed", error);
    return [];
  }
  type Row = DesignPackageRow & {
    trend_briefs:
      | (Pick<TrendBriefRow, "id" | "niche" | "color_palette"> & {
          claude_analysis: unknown;
          image_model: unknown;
          background_removal_mode: unknown;
          image_description: string | null;
        })
      | null;
  };
  return (data as Row[]).map((r) => ({
    ...r,
    regen_stack: extractRegenStack(r.metadata),
    trend_brief: r.trend_briefs
      ? {
          id: r.trend_briefs.id,
          niche: r.trend_briefs.niche,
          color_palette: r.trend_briefs.color_palette,
          style: extractStyle(r.trend_briefs.claude_analysis),
          image_model: narrowImageModel(r.trend_briefs.image_model),
          background_removal_mode: narrowBgRemoval(
            r.trend_briefs.background_removal_mode,
          ),
          image_description: r.trend_briefs.image_description ?? null,
        }
      : null,
  }));
}

/** DesignPackageRow extended with UI-only flags derived server-side. */
export interface DesignGridRow extends DesignPackageRow {
  /**
   * True when at least one non-error listing references this design.
   * The Reopen action refuses in this state — surface it in the UI so the
   * operator sees why instead of hitting a server-action error overlay.
   */
  has_blocking_listing: boolean;
}

/**
 * Full design history. Capped at 500 for now — paginate once exceeded.
 */
export async function getAllDesigns(limit = 500): Promise<DesignGridRow[]> {
  return getRecentDesigns(limit);
}

export async function getRecentDesigns(limit = 24): Promise<DesignGridRow[]> {
  const db = serviceClient();
  const [{ data, error }, { data: blocking }] = await Promise.all([
    db
      .from("design_packages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit),
    // IDs of designs that have a listing at needs_review or beyond — i.e. the
    // listing agent has done meaningful work on this design. Used to lock
    // Reopen, Regen, and Delete so the operator doesn't accidentally undo a
    // design that's already in the listing pipeline. "pending" is excluded:
    // the agent is merely queued and no copy/mockups exist yet.
    db
      .from("listings")
      .select("design_package_id")
      .in("status", ["needs_review", "pending_publish", "publishing", "active"])
      .not("design_package_id", "is", null),
  ]);
  if (error) {
    console.error("getRecentDesigns failed", error);
    return [];
  }
  const blockingIds = new Set(
    (blocking ?? []).map((r) => (r as { design_package_id: string }).design_package_id),
  );
  return (data ?? []).map((d) => ({
    ...(d as DesignPackageRow),
    has_blocking_listing: blockingIds.has((d as DesignPackageRow).id),
  }));
}

export interface DesignSpend {
  flux_pro_usd: number;
  aura_sr_usd: number;
  birefnet_usd: number;
  total_usd: number;
  designs_done: number;
  avg_cost_per_design: number | null;
  cache_hits: number;
}

export async function getDesignSpend(windowDays: number): Promise<DesignSpend> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();

  const { data: usage } = await db
    .from("llm_usage")
    .select("operation, cost_usd, metadata")
    .eq("provider", "fal")
    .gte("created_at", since);

  const spend = { flux_pro_usd: 0, aura_sr_usd: 0, birefnet_usd: 0, total_usd: 0 };
  let cache_hits = 0;
  for (const row of (usage ?? []) as { operation: string; cost_usd: number | null; metadata: { cache_hit?: boolean } | null }[]) {
    const cost = Number(row.cost_usd ?? 0);
    spend.total_usd += cost;
    if (row.operation.startsWith("flux")) spend.flux_pro_usd += cost;
    else if (row.operation.startsWith("aura")) spend.aura_sr_usd += cost;
    else if (row.operation.startsWith("birefnet")) spend.birefnet_usd += cost;
    if (row.metadata?.cache_hit) cache_hits += 1;
  }

  const { count: designsCount } = await db
    .from("design_packages")
    .select("id", { count: "exact", head: true })
    .eq("status", "done")
    .gte("created_at", since);

  const designs_done = designsCount ?? 0;
  return {
    ...spend,
    designs_done,
    avg_cost_per_design: designs_done ? spend.total_usd / designs_done : null,
    cache_hits,
  };
}
