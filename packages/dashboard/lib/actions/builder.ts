"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import {
  buildPromptDescription,
  BuildPromptError,
  type CreativeHooks,
  type ScoutSignals,
} from "@/lib/builder/build-prompt";
import { STYLE_IDS, type StyleId } from "@/lib/styles/catalog";
import {
  IMAGE_MODEL_IDS,
  type ImageModelId,
} from "@/lib/models/image-models";

// Validates the style chip the operator picked. Empty / null / unknown all
// collapse to `null` so the build proceeds in "Auto" mode rather than failing
// on a malformed input that the operator can't see in the UI.
function parseStyle(raw: unknown): StyleId | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return (STYLE_IDS as readonly string[]).includes(raw)
    ? (raw as StyleId)
    : null;
}

// Image-model chip parser. Empty/missing/unknown → null = "use whatever the
// parent brief already has, or the global default for fresh briefs". Lets
// the Builder picker omit Auto without breaking older form posts.
function parseImageModelChip(raw: unknown): ImageModelId | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return (IMAGE_MODEL_IDS as readonly string[]).includes(raw)
    ? (raw as ImageModelId)
    : null;
}

/**
 * Server actions for the Builder step.
 *
 * Pipeline:
 *   Scout writes brief at 'needs_review'
 *   → operator approves on Scout page → status='needs_description'
 *   → operator opens it in Builder, types a free-form seed
 *   → Builder calls Claude to flesh the seed into a render-ready description
 *   → operator edits if needed, then sends it to Design
 *   → Builder writes prompt_constraint and flips status='approved'
 *   → Design claims status='approved' and generates the print-ready image
 *
 * Four entry points:
 *   - buildPromptForBrief — Claude call for a from-Scout brief. Reads Scout's
 *     trend signals from the brief and uses them as priors. Does NOT mutate
 *     the brief; returns the fleshed description to the client.
 *   - buildPromptManual — Claude call for a manual entry. No Scout priors.
 *   - sendToDesign — from-Scout flow: writes the (possibly operator-edited)
 *     description to prompt_constraint and flips status='approved'.
 *   - createManualBrief — manual flow: creates a new brief at status='approved'
 *     with the operator's niche + description.
 */

async function assertOwner(): Promise<string> {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
  return email;
}

const idSchema = z.string().uuid();
const descriptionSchema = z
  .string()
  .min(10, "Description must be at least 10 characters")
  .max(2000, "Description must be 2000 characters or fewer");

// Operator seeds are free-form: a bare subject like "bulldog trashman" is fine
// (3+ chars covers it), and the upper bound is generous so a seasoned operator
// can paste a near-complete description if they want Builder to only polish it.
const seedSchema = z
  .string()
  .trim()
  .min(3, "Seed must be at least 3 characters")
  .max(1000, "Seed must be 1000 characters or fewer");

// Up to three reference images per build — caps Claude vision cost per call
// (~$0.005 each) and prevents the "too many anchors" failure mode where the
// model averages references into mush instead of treating each as a distinct
// composition/style/palette anchor. URLs are consumed at build time only and
// never persisted.
const MAX_REFERENCE_IMAGES = 3;

// Accepts a comma-separated string from the UI ("https://a.jpg, https://b.png"),
// trims, drops empties, validates each as http(s), and rejects if > MAX. Returns
// string[] | null — null when no URLs were given so downstream code can branch
// on presence cleanly.
const referenceUrlsSchema = z
  .string()
  .trim()
  .max(6000) // generous: 3 URLs × ~2000 chars each
  .transform((v) => v.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
  .refine(
    (urls) => urls.every((u) => /^https?:\/\//i.test(u)),
    { message: "Each reference URL must start with http:// or https://" },
  )
  .refine(
    (urls) => urls.length <= MAX_REFERENCE_IMAGES,
    { message: `At most ${MAX_REFERENCE_IMAGES} reference URLs allowed (comma-separated)` },
  )
  .transform((urls) => (urls.length === 0 ? null : urls));

// Default niche for manual entries when the operator doesn't pick one.
// Matches the "original design" language the operator uses for one-off pieces
// that don't sit under a specific trend niche.
const DEFAULT_MANUAL_NICHE = "original design";
const nicheSchema = z.string().trim().min(2).max(120);

/** Discriminated return so client components can render the error in-line
 * instead of bubbling it to the Next.js error boundary. Build is an expected-
 * fallible operation (Claude hiccups, schema mismatches) — surfaced gently. */
export type BuildResult =
  | { ok: true; description: string }
  | { ok: false; error: string };

export async function buildPromptForBrief(
  briefId: string,
  rawSeed: string,
  rawReferenceUrls = "",
  rawStyle: string | null = null,
  rawArtReference: string | null = null,
  rawTextInDesign: string | null = null,
  rawPoseAction: string | null = null,
): Promise<BuildResult> {
  await assertOwner();
  const parsedId = idSchema.safeParse(briefId);
  if (!parsedId.success) {
    return { ok: false, error: "Invalid brief id" };
  }
  const parsedSeed = seedSchema.safeParse(rawSeed);
  if (!parsedSeed.success) {
    return { ok: false, error: parsedSeed.error.issues[0]?.message ?? "Invalid seed" };
  }
  const parsedUrls = referenceUrlsSchema.safeParse(rawReferenceUrls);
  if (!parsedUrls.success) {
    return { ok: false, error: parsedUrls.error.issues[0]?.message ?? "Invalid URL(s)" };
  }

  const db = serviceClient();
  const { data: brief, error: readErr } = await db
    .from("trend_briefs")
    .select("niche, style_keywords, top_tags, color_palette, status")
    .eq("id", parsedId.data)
    .maybeSingle();
  if (readErr) {
    return { ok: false, error: `Brief read failed: ${readErr.message}` };
  }
  if (!brief) {
    return { ok: false, error: "Brief not found" };
  }
  if (brief.status !== "needs_description") {
    return {
      ok: false,
      error: `Cannot build for status='${brief.status}' (expected 'needs_description')`,
    };
  }

  const scout: ScoutSignals = {
    niche: brief.niche as string,
    style_keywords: brief.style_keywords as string[] | null,
    top_tags: brief.top_tags as string[] | null,
    color_palette: brief.color_palette as string[] | null,
  };

  const hooks: CreativeHooks = {
    artReference: rawArtReference?.trim() || null,
    textInDesign: rawTextInDesign?.trim() || null,
    poseAction: rawPoseAction?.trim() || null,
  };

  try {
    const description = await buildPromptDescription(
      parsedSeed.data,
      scout,
      parsedUrls.data,
      parseStyle(rawStyle),
      hooks,
    );
    return { ok: true, description };
  } catch (err) {
    const message =
      err instanceof BuildPromptError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `Builder failed: ${message}` };
  }
}

export async function buildPromptManual(
  rawSeed: string,
  rawReferenceUrls = "",
  rawStyle: string | null = null,
): Promise<BuildResult> {
  await assertOwner();
  const parsedSeed = seedSchema.safeParse(rawSeed);
  if (!parsedSeed.success) {
    return { ok: false, error: parsedSeed.error.issues[0]?.message ?? "Invalid seed" };
  }
  const parsedUrls = referenceUrlsSchema.safeParse(rawReferenceUrls);
  if (!parsedUrls.success) {
    return { ok: false, error: parsedUrls.error.issues[0]?.message ?? "Invalid URL(s)" };
  }

  try {
    const description = await buildPromptDescription(
      parsedSeed.data,
      null,
      parsedUrls.data,
      parseStyle(rawStyle),
    );
    return { ok: true, description };
  } catch (err) {
    const message =
      err instanceof BuildPromptError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `Builder failed: ${message}` };
  }
}

export async function sendToDesign(formData: FormData): Promise<void> {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const description = descriptionSchema.parse(formData.get("description"));
  // Style chip the operator had selected at Send time. Persisted on the
  // child brief so the Design review picker can reflect the original choice
  // instead of defaulting to Auto when the operator returns to review.
  const style = parseStyle(formData.get("style"));
  // Image-model chip. Null = "inherit the parent brief's model" — that's
  // typically the Scout-research brief's default, which itself was seeded
  // from the global default_image_model runtime flag.
  const imageModel = parseImageModelChip(formData.get("image_model"));

  const db = serviceClient();

  // The parent brief stays in the Builder queue so the operator can spawn
  // multiple designs from the same trend signal + seed iteration. Each
  // "Send to Design" creates a CHILD brief — a clone of the parent's research
  // fields with the operator's image description attached and status=approved
  // so Design's claim RPC picks it up. The parent's status is never touched.
  const { data: parent, error: readErr } = await db
    .from("trend_briefs")
    .select(
      "id, status, niche, style_keywords, top_tags, color_palette, price_target_usd, raw_etsy_data, claude_analysis, image_model, image_quality",
    )
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw new Error(`Brief read failed: ${readErr.message}`);
  if (!parent) throw new Error("Brief not found");
  if (parent.status !== "needs_description") {
    throw new Error(
      `Cannot send from status='${parent.status}' (expected 'needs_description')`,
    );
  }

  // Provenance: tag the child so the dashboard can distinguish spawned briefs
  // from Scout-research briefs, and so future code can backtrack to the parent.
  const parentAnalysis =
    parent.claude_analysis && typeof parent.claude_analysis === "object"
      ? (parent.claude_analysis as Record<string, unknown>)
      : {};
  const childAnalysis = {
    ...parentAnalysis,
    source: "builder_spawn",
    parent_brief_id: parent.id,
    // Null when operator left the chip on Auto; lets queries .filter on style.
    style,
  };

  const { error: insertErr } = await db.from("trend_briefs").insert({
    niche: parent.niche,
    style_keywords: parent.style_keywords,
    top_tags: parent.top_tags,
    color_palette: parent.color_palette,
    price_target_usd: parent.price_target_usd,
    raw_etsy_data: parent.raw_etsy_data,
    claude_analysis: childAnalysis,
    // Operator override > parent's model. Operator left chip on Auto →
    // clone parent's model (which itself was seeded from the global default).
    image_model: imageModel ?? parent.image_model,
    image_quality: parent.image_quality,
    // Builder's Claude pass (buildPromptDescription) already produced a
    // complete style-aware description. Land it on the canonical
    // image_description column so Design uses it verbatim and appends only
    // print-readiness clauses — no second Claude synthesis, no stacking.
    image_description: description.trim(),
    status: "approved",
  });
  if (insertErr) throw new Error(`Send to Design failed: ${insertErr.message}`);

  // No agent auto-trigger: Design only runs when the operator clicks
  // Run Design on the Design page. The new child brief sits at
  // status='approved' waiting in the queue; the Run button's gold glow
  // signals the work is ready.

  revalidatePath("/builder");
  revalidatePath("/design");
  revalidatePath("/");
}

/**
 * Archive a brief that is waiting at 'needs_description'.
 *
 * Moves the brief out of the active Builder queue without deleting it.
 * Archived briefs are excluded from the Ledger watchdog's stale-brief counts
 * and from getBuilderQueue. The operator can restore or delete from the
 * Builder page's Archived section.
 *
 * Status guard: only transitions from 'needs_description' → 'archived'.
 * The optimistic `.eq('status','needs_description')` prevents archiving a
 * brief that has concurrently moved to another state.
 */
export async function archiveBrief(formData: FormData): Promise<void> {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { error } = await db
    .from("trend_briefs")
    .update({ status: "archived", error_message: null })
    .eq("id", id)
    .eq("status", "needs_description"); // optimistic concurrency
  if (error) throw new Error(`Archive failed: ${error.message}`);

  revalidatePath("/builder");
  revalidatePath("/");
}

/**
 * Restore an archived brief back to the Builder queue.
 *
 * Flips status 'archived' → 'needs_description' so it reappears in
 * getBuilderQueue and the operator can continue fleshing it out.
 */
export async function unarchiveBrief(formData: FormData): Promise<void> {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { error } = await db
    .from("trend_briefs")
    .update({ status: "needs_description", error_message: null })
    .eq("id", id)
    .eq("status", "archived"); // optimistic concurrency
  if (error) throw new Error(`Restore failed: ${error.message}`);

  revalidatePath("/builder");
  revalidatePath("/");
}

export async function createManualBrief(formData: FormData): Promise<void> {
  await assertOwner();
  const description = descriptionSchema.parse(formData.get("description"));
  const rawNiche = formData.get("niche")?.toString().trim() ?? "";
  const niche = nicheSchema.parse(rawNiche || DEFAULT_MANUAL_NICHE);
  const style = parseStyle(formData.get("style"));
  const imageModel = parseImageModelChip(formData.get("image_model"));

  const db = serviceClient();
  // Manual briefs skip the Scout-research and Scout-approve gates — the
  // operator authored both the niche and the description themselves. Land
  // them at status='approved' so Design claims on its next manual run.
  // Null model = let the DB default kick in (column default mirrors the
  // global default_image_model flag's seed value).
  const insertRow: Record<string, unknown> = {
    niche,
    // See sendToDesign: Builder owns the full image description; land it on
    // image_description so Design uses it verbatim.
    image_description: description.trim(),
    status: "approved",
    claude_analysis: { source: "builder_manual", style },
  };
  if (imageModel) insertRow.image_model = imageModel;
  const { error } = await db.from("trend_briefs").insert(insertRow);
  if (error) throw new Error(`Create manual brief failed: ${error.message}`);

  // No auto-trigger — see sendToDesign for rationale.

  revalidatePath("/builder");
  revalidatePath("/design");
  revalidatePath("/");
}
