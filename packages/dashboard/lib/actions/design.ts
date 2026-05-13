"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import { maybeAutoTrigger } from "@/lib/actions/triggers";

async function assertOwner() {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
  return email;
}

const idSchema = z.string().uuid();

// Mirrors the FluxPrompt validator in packages/shared_py/models.py. Only
// enforced when image_model is fal_flux_pro — gpt-image-2 takes natural
// English and skips the ritual-phrase check. Keep both lists in sync with
// the Python side.
const FLUX_REQUIRED_TERMS = [
  "print on demand design",
  "vector-style",
] as const;
const FLUX_REQUIRED_BACKGROUND_TERMS = [
  "white background",
  "black background",
] as const;

export async function approveDesign(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("design_packages")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Design not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}' (expected 'needs_review')`);
  }

  const { error } = await db
    .from("design_packages")
    .update({ status: "approved", error_message: null })
    .eq("id", id)
    .eq("status", "needs_review");
  if (error) throw new Error(`Approve failed: ${error.message}`);

  // Chain into Listing when manual mode is off + local triggers are enabled.
  await maybeAutoTrigger("listing", email);

  revalidatePath("/design");
  revalidatePath("/listings");
  revalidatePath("/");
}

export async function regenerateDesign(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  // Optional edited prompt — when present, write it to
  // trend_briefs.custom_flux_prompt so prompt_builder.py uses it verbatim on
  // the next run (skipping Claude). Empty/whitespace = leave the column alone.
  const editedPromptRaw = formData.get("custom_flux_prompt");
  const editedPrompt =
    typeof editedPromptRaw === "string" ? editedPromptRaw.trim() : "";
  // Optional palette edit — when the form includes a color_palette field,
  // we update the brief's color_palette column. Absent field = leave alone.
  // We need a way to distinguish "field absent" from "field present and empty"
  // (the latter is the operator explicitly clearing the palette), so the
  // sentinel value "__missing__" stands in for "field wasn't in the form".
  const rawPalette = formData.get("color_palette");
  const paletteAction:
    | { kind: "skip" }
    | { kind: "set"; value: string[] | null } =
    rawPalette === null
      ? { kind: "skip" }
      : {
          kind: "set",
          value: (() => {
            const arr = parsePaletteField(rawPalette);
            const valid = arr.filter((h) => /^#[0-9a-f]{6}$/.test(h));
            return valid.length > 0 ? valid : null;
          })(),
        };
  const db = serviceClient();

  // Clear the design row's downstream state, then revert the upstream brief
  // to 'approved' so Design's claim RPC re-picks it up on the next run.
  const { data: design } = await db
    .from("design_packages")
    .select("trend_brief_id")
    .eq("id", id)
    .maybeSingle();
  if (!design) throw new Error("Design not found");

  const { error: dpErr } = await db
    .from("design_packages")
    .update({
      status: "pending",
      image_url: null,
      image_url_unmasked: null,
      mockup_urls: null,
      fal_prompt: null,
      fal_prompt_hash: null,
      error_message: null,
      retry_count: 0,
    })
    .eq("id", id);
  if (dpErr) throw new Error(`Regenerate failed: ${dpErr.message}`);

  if (design.trend_brief_id) {
    const briefUpdate: Record<string, unknown> = {
      status: "approved",
      error_message: null,
      retry_count: 0,
    };
    if (editedPrompt.length > 0) {
      briefUpdate.custom_flux_prompt = editedPrompt;
    }
    if (paletteAction.kind === "set") {
      briefUpdate.color_palette = paletteAction.value;
    }
    const { error: tbErr } = await db
      .from("trend_briefs")
      .update(briefUpdate)
      .eq("id", design.trend_brief_id);
    if (tbErr) throw new Error(`Trend brief reset failed: ${tbErr.message}`);
  }

  revalidatePath("/design");
  revalidatePath("/scout");
}

export async function retryDesign(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // Same logic as regenerate but preserves the existing prompt/image. Reverts
  // trend_brief to 'approved' so the claim RPC re-picks it up.
  const { data: design } = await db
    .from("design_packages")
    .select("trend_brief_id")
    .eq("id", id)
    .maybeSingle();
  if (!design) throw new Error("Design not found");

  const { error: dpErr } = await db
    .from("design_packages")
    .update({ status: "pending", retry_count: 0, error_message: null })
    .eq("id", id);
  if (dpErr) throw new Error(`Retry failed: ${dpErr.message}`);

  if (design.trend_brief_id) {
    const { error: tbErr } = await db
      .from("trend_briefs")
      .update({ status: "approved", error_message: null })
      .eq("id", design.trend_brief_id);
    if (tbErr) throw new Error(`Trend brief reset failed: ${tbErr.message}`);
  }

  revalidatePath("/design");
  revalidatePath("/scout");
}

// Hex color in #rrggbb form (lowercase). Normalized client-side by
// ColorPaletteEditor before serialization; this is the strict post-normalize
// shape — anything else (3-digit shorthand, uppercase, missing #) gets
// rejected here so a malformed palette doesn't poison the brief.
const HexColor = z.string().regex(/^#[0-9a-f]{6}$/);

const InjectDesignSchema = z.object({
  niche: z.string().min(2).max(120),
  custom_flux_prompt: z.string().min(20).max(2000),
  image_model: z
    .enum(["fal_flux_pro", "fal_gpt_image_2"])
    .default("fal_gpt_image_2"),
  image_quality: z.enum(["low", "medium", "high"]).default("medium"),
  // Up to 5 ink colors. Empty array = no palette constraint; the agent picks.
  // The prompt-builder reads this off `trend_briefs.color_palette` and
  // injects a "use only these inks" clause into the image-gen prompt.
  color_palette: z.array(HexColor).max(5).default([]),
});

function parsePaletteField(raw: FormDataEntryValue | null): string[] {
  // The ColorPaletteEditor emits the palette as JSON in a hidden input.
  // Defend against missing / malformed values — InjectDesignSchema's HexColor
  // regex will reject anything still off-shape after the JSON parse.
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function injectDesign(formData: FormData) {
  await assertOwner();
  const parsed = InjectDesignSchema.parse({
    niche: formData.get("niche"),
    custom_flux_prompt: formData.get("custom_flux_prompt"),
    image_model: (formData.get("image_model") ?? "fal_gpt_image_2") as
      | "fal_flux_pro"
      | "fal_gpt_image_2",
    image_quality: (formData.get("image_quality") ?? "medium") as
      | "low"
      | "medium"
      | "high",
    color_palette: parsePaletteField(formData.get("color_palette")),
  });

  // Up-front compliance for FLUX prompts only — the agent's FluxPrompt
  // validator will reject the same way, but we surface it here for instant
  // feedback. gpt-image-2 briefs take natural English and skip this check.
  if (parsed.image_model === "fal_flux_pro") {
    const lower = parsed.custom_flux_prompt.toLowerCase();
    const missing = FLUX_REQUIRED_TERMS.filter((t) => !lower.includes(t));
    if (missing.length > 0) {
      throw new Error(
        `FLUX prompt must contain: ${missing.map((m) => `"${m}"`).join(", ")}`,
      );
    }
    if (!FLUX_REQUIRED_BACKGROUND_TERMS.some((t) => lower.includes(t))) {
      throw new Error(
        `FLUX prompt must specify a solid background: one of ${FLUX_REQUIRED_BACKGROUND_TERMS
          .map((t) => `"${t}"`)
          .join(" or ")}`,
      );
    }
  }

  const db = serviceClient();
  // Skip the review gate for manually-injected briefs — the operator wrote the
  // prompt themselves, so 'needs_review → approved' would just be one extra
  // click reviewing your own work. Scout's auto-discovered briefs still land
  // at 'needs_review' (that's the queue the review gate exists for).
  // image_quality is only consumed by gpt-image-2; FLUX briefs persist NULL.
  const { error } = await db.from("trend_briefs").insert({
    niche: parsed.niche,
    status: "approved",
    custom_flux_prompt: parsed.custom_flux_prompt,
    image_model: parsed.image_model,
    image_quality:
      parsed.image_model === "fal_gpt_image_2" ? parsed.image_quality : null,
    // NULL when no palette specified — the agent picks colors freely.
    color_palette: parsed.color_palette.length > 0 ? parsed.color_palette : null,
    claude_analysis: { source: "dashboard_inject_design" },
  });
  if (error) throw new Error(`Inject failed: ${error.message}`);

  revalidatePath("/design");
  revalidatePath("/scout");
}

export async function deleteDesign(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // listings.design_package_id → design_packages(id) is NO ACTION (no
  // cascade). A delete with referencing listings would throw a FK violation
  // anyway — give a friendlier error first.
  const { count: listingCount, error: countErr } = await db
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("design_package_id", id);
  if (countErr) throw new Error(`Listing reference check failed: ${countErr.message}`);
  if ((listingCount ?? 0) > 0) {
    throw new Error(
      `Cannot delete: ${listingCount} listing(s) reference this design. Reject or delete those first from the Listings page.`,
    );
  }

  const { error } = await db.from("design_packages").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);

  revalidatePath("/design");
}
