"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import { spawnAgentForOperatorAction } from "@/lib/actions/triggers";
import { STYLE_IDS, type StyleId } from "@/lib/styles/catalog";
import {
  IMAGE_MODEL_IDS,
  type ImageModelId,
} from "@/lib/models/image-models";
import {
  BG_REMOVAL_IDS,
  type BgRemovalModeId,
} from "@/lib/models/bg-removal";

// Three-state encoding for the style chip on regen: "skip" means the form
// didn't include the field at all (legacy callers); "set" carries the new
// value to write into claude_analysis.style (null for Auto). Distinguishing
// "absent" from "explicit Auto" lets us avoid wiping a prior chip choice
// when a future caller forgets to submit the field.
type StyleAction = { kind: "skip" } | { kind: "set"; value: StyleId | null };

function parseStyleAction(raw: FormDataEntryValue | null): StyleAction {
  if (raw === null) return { kind: "skip" };
  if (typeof raw !== "string") return { kind: "skip" };
  if (raw === "") return { kind: "set", value: null };
  return (STYLE_IDS as readonly string[]).includes(raw)
    ? { kind: "set", value: raw as StyleId }
    : { kind: "set", value: null };
}

// Two-state encoding for the image-model picker on regen: "skip" when the
// field is absent (legacy callers) or empty; "set" for a recognized model.
// We never write null here — image_model is NOT NULL in the schema, and
// "Auto" doesn't make sense at the brief level (the brief has to be tagged
// with a concrete model so the Design agent's dispatcher can pick a client).
type ImageModelAction =
  | { kind: "skip" }
  | { kind: "set"; value: ImageModelId };

function parseImageModelAction(raw: FormDataEntryValue | null): ImageModelAction {
  if (raw === null || typeof raw !== "string" || raw === "") return { kind: "skip" };
  return (IMAGE_MODEL_IDS as readonly string[]).includes(raw)
    ? { kind: "set", value: raw as ImageModelId }
    : { kind: "skip" };
}

// Three-state for the bg-removal chip on regen:
//   "skip"  → field absent (legacy callers); leave column alone
//   "set:null" → operator explicitly chose Default; clear any prior override
//                so the brief falls back to the global runtime flag
//   "set:id"   → operator chose a specific backend; pin the brief to it
type BgRemovalAction =
  | { kind: "skip" }
  | { kind: "set"; value: BgRemovalModeId | null };

function parseBgRemovalAction(raw: FormDataEntryValue | null): BgRemovalAction {
  if (raw === null) return { kind: "skip" };
  if (typeof raw !== "string") return { kind: "skip" };
  if (raw === "") return { kind: "set", value: null };
  return (BG_REMOVAL_IDS as readonly string[]).includes(raw)
    ? { kind: "set", value: raw as BgRemovalModeId }
    : { kind: "set", value: null };
}

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

// Optional `version_index` on approve/remask submits identifies a stack entry
// in design_packages.metadata.image_versions. The action snaps the row's
// image_url / image_url_unmasked to that entry's pair before the status flip
// (approve) or before triggering the Python sweep (remask). Absent / blank /
// out-of-range values fall through to "use the row's current pointer".
function parseVersionIndex(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

type RegenVersion = {
  kind: "regen";
  masked_url: string;
  unmasked_url: string | null;
};

function pickStackEntry(
  metadata: unknown,
  index: number,
): RegenVersion | null {
  if (!metadata || typeof metadata !== "object") return null;
  const versions = (metadata as Record<string, unknown>).image_versions;
  if (!Array.isArray(versions)) return null;
  const stack = versions.filter(
    (v): v is RegenVersion =>
      !!v &&
      typeof v === "object" &&
      (v as Record<string, unknown>).kind === "regen" &&
      typeof (v as Record<string, unknown>).masked_url === "string",
  );
  return stack[index] ?? null;
}

export async function approveDesign(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const versionIndex = parseVersionIndex(formData.get("version_index"));
  const db = serviceClient();

  const { data: row } = await db
    .from("design_packages")
    .select("status, metadata, image_url, image_url_unmasked")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Design not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}' (expected 'needs_review')`);
  }

  const update: Record<string, unknown> = {
    status: "approved",
    error_message: null,
  };

  if (versionIndex !== null) {
    const entry = pickStackEntry(row.metadata, versionIndex);
    if (!entry) {
      throw new Error(
        `Approve failed: stack entry #${versionIndex} not found. ` +
          "The version may have aged out of the cap or the page is stale; refresh and try again.",
      );
    }
    // Only rewrite if the chosen entry actually differs from the row's
    // current pointer — avoids a no-op metadata churn when the operator
    // approves the latest entry without navigating.
    if (entry.masked_url !== row.image_url) {
      update.image_url = entry.masked_url;
    }
    if (entry.unmasked_url !== row.image_url_unmasked) {
      update.image_url_unmasked = entry.unmasked_url;
    }
  }

  const { error } = await db
    .from("design_packages")
    .update(update)
    .eq("id", id)
    .eq("status", "needs_review");
  if (error) throw new Error(`Approve failed: ${error.message}`);

  // No auto-trigger: Listing only runs when the operator clicks Run Listing.
  // The approved design sits in the Listing queue; the Run Listing button's
  // gold glow signals there's work waiting.

  revalidatePath("/design");
  revalidatePath("/listings");
  revalidatePath("/");
}

/**
 * Reopen an approved design back into the review queue without regenerating.
 *
 * Use case: after approving, the operator wants to step through the version
 * stack again, swap the bg-removal mode, or change the chosen iteration —
 * none of which require paying for a fresh image gen. Reopen flips the row
 * back to needs_review (no agent spawn, no clearing, no metadata changes)
 * so the existing review card appears with the full stack intact.
 *
 * Refuses if any listing referencing this design is in a non-error status —
 * mirrors the deleteDesign guard. Reject the listing first (which moves it
 * to status='error') if you really need to mutate the source design.
 */
export async function reopenDesign(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("design_packages")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Design not found");
  if (row.status !== "approved") {
    throw new Error(
      `Cannot reopen from status='${row.status}' (expected 'approved')`,
    );
  }

  const { count: blockingListings, error: countErr } = await db
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("design_package_id", id)
    .neq("status", "error");
  if (countErr) {
    throw new Error(`Listing reference check failed: ${countErr.message}`);
  }
  if ((blockingListings ?? 0) > 0) {
    throw new Error(
      `Cannot reopen: ${blockingListings} listing(s) reference this design. ` +
        "Reject the listing first from the Listings page.",
    );
  }

  const { error } = await db
    .from("design_packages")
    .update({ status: "needs_review", error_message: null })
    .eq("id", id)
    .eq("status", "approved");
  if (error) throw new Error(`Reopen failed: ${error.message}`);

  revalidatePath("/design");
  revalidatePath("/listings");
}

export async function regenerateDesign(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  // Optional edited prompt — when present, write it to
  // trend_briefs.image_description so prompt_builder.py uses it verbatim on
  // the next run (skipping Claude). Empty/whitespace = leave the column alone.
  //
  // Normalize line endings to LF: HTML form submission encodes textarea
  // newlines as CRLF (per spec). The dashboard's [STYLE LOCK] sentinel and
  // the Python preprocessor's substring detectors both compare against LF
  // sequences, so persisting CRLF causes detect-and-replace logic to fail
  // and dupes to accumulate across regens.
  const editedPromptRaw = formData.get("image_description");
  const editedPrompt =
    typeof editedPromptRaw === "string"
      ? editedPromptRaw.replace(/\r\n/g, "\n").trim()
      : "";
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
  const styleAction = parseStyleAction(formData.get("style"));
  const modelAction = parseImageModelAction(formData.get("image_model"));
  const bgRemovalAction = parseBgRemovalAction(
    formData.get("background_removal_mode"),
  );
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
      briefUpdate.image_description = editedPrompt;
    }
    if (paletteAction.kind === "set") {
      briefUpdate.color_palette = paletteAction.value;
    }
    if (modelAction.kind === "set") {
      briefUpdate.image_model = modelAction.value;
      // Reset image_quality when switching TO FLUX (no quality tier).
      // gpt-image-2 → nano-banana-2 (both use the same tier semantics)
      // doesn't need a reset; leave existing quality intact.
      if (modelAction.value === "fal_flux_pro") {
        briefUpdate.image_quality = null;
      }
    }
    if (bgRemovalAction.kind === "set") {
      // null = clear the override → Python falls back to the runtime flag.
      briefUpdate.background_removal_mode = bgRemovalAction.value;
    }
    // Merge style into claude_analysis without clobbering existing keys
    // (source, parent_brief_id, etc.). Read-modify-write is safe here
    // because regen is per-row and the brief is owned by Design's claim
    // RPC — concurrent writers can't collide on the same brief mid-regen.
    if (styleAction.kind === "set") {
      const { data: brief } = await db
        .from("trend_briefs")
        .select("claude_analysis")
        .eq("id", design.trend_brief_id)
        .maybeSingle();
      const existing =
        brief?.claude_analysis && typeof brief.claude_analysis === "object"
          ? (brief.claude_analysis as Record<string, unknown>)
          : {};
      briefUpdate.claude_analysis = { ...existing, style: styleAction.value };
    }
    const { error: tbErr } = await db
      .from("trend_briefs")
      .update(briefUpdate)
      .eq("id", design.trend_brief_id);
    if (tbErr) throw new Error(`Trend brief reset failed: ${tbErr.message}`);
  }

  // Operator-initiated Regen on the Design surface — spawn the agent right
  // away so the work starts now, not on the next Run Design click. Distinct
  // from the upstream-chain auto-trigger we removed earlier: that was
  // Builder/Approve secretly kicking off downstream work; THIS is the
  // operator on the Design page clicking Regen on a Design row, which is
  // an unambiguous "do this now" signal.
  await spawnAgentForOperatorAction("design", email);

  revalidatePath("/design");
  revalidatePath("/scout");
}

/**
 * Cheap-regen path: re-run only background removal on an existing design,
 * reusing the persisted image_url_unmasked. ~$0.02 per click vs ~$0.10–0.30
 * for a full Regen.
 *
 * Workflow:
 *   1. Persist any operator-edited brief fields (style chip, bg-removal
 *      chip, palette) so the re-mask uses the operator's current choices.
 *      Same shape as regenerateDesign — we share the field parsers.
 *   2. Clear the design row's downstream state and flip remask_only=true,
 *      status='pending'. The Design agent's remask sweep claims rows with
 *      this flag and runs only bg-removal + Pillow + upload.
 *   3. Brief stays where it is — re-mask is a design-row operation, not a
 *      brief-pipeline rerun.
 *
 * Refuses when image_url_unmasked is null: the unmasked image is the source
 * we re-mask from. Without it, only a full Regen can recover.
 */
export async function remaskDesign(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const bgRemovalAction = parseBgRemovalAction(
    formData.get("background_removal_mode"),
  );
  // Optional stack-entry pointer. When the operator hits Re-mask while
  // displaying a historical stack entry, this lets us snap the row's
  // image_url_unmasked to that entry's unmasked source so the Python sweep
  // re-masks the chosen iteration rather than the row's "latest" pointer.
  const versionIndex = parseVersionIndex(formData.get("version_index"));
  const db = serviceClient();

  const { data: design } = await db
    .from("design_packages")
    .select("trend_brief_id,image_url_unmasked,status,metadata")
    .eq("id", id)
    .maybeSingle();
  if (!design) throw new Error("Design not found");
  if (!design.image_url_unmasked) {
    throw new Error(
      "Re-mask unavailable: no unmasked image saved for this design. Use Regen instead.",
    );
  }
  if (design.status !== "needs_review" && design.status !== "error") {
    throw new Error(
      `Cannot re-mask from status='${design.status}' (expected 'needs_review' or 'error')`,
    );
  }

  // Persist the bg-removal chip onto the linked brief so the Python sweep
  // resolves to the operator's intended backend. Other chip changes (style,
  // image_model, palette) aren't honored by the re-mask path — re-mask
  // never re-runs image gen, so a model swap there would be misleading.
  if (design.trend_brief_id && bgRemovalAction.kind === "set") {
    const { error: tbErr } = await db
      .from("trend_briefs")
      .update({ background_removal_mode: bgRemovalAction.value })
      .eq("id", design.trend_brief_id);
    if (tbErr) throw new Error(`Brief update failed: ${tbErr.message}`);
  }

  // Resolve which unmasked source the sweep should re-mask. Default = the
  // row's current image_url_unmasked (existing behavior). When the operator
  // is browsing the stack, swap in the chosen entry's unmasked_url so the
  // sweep operates on that historical iteration. The Python side matches by
  // URL when rewriting the corresponding stack entry's masked_url, so writing
  // the chosen URL onto the row is what links the two sides.
  const dpUpdate: Record<string, unknown> = {
    status: "pending",
    remask_only: true,
    error_message: null,
    retry_count: 0,
  };
  if (versionIndex !== null) {
    const entry = pickStackEntry(design.metadata, versionIndex);
    if (!entry) {
      throw new Error(
        `Re-mask failed: stack entry #${versionIndex} not found.`,
      );
    }
    if (!entry.unmasked_url) {
      throw new Error(
        "Re-mask failed: chosen stack entry has no unmasked image to mask from.",
      );
    }
    if (entry.unmasked_url !== design.image_url_unmasked) {
      dpUpdate.image_url_unmasked = entry.unmasked_url;
    }
  }

  // Flip the design row into the re-mask queue. We DON'T clear image_url
  // here — the operator keeps seeing the current image until the new one
  // lands. Status='pending' + remask_only=true is the claim signal.
  const { error: dpErr } = await db
    .from("design_packages")
    .update(dpUpdate)
    .eq("id", id);
  if (dpErr) throw new Error(`Re-mask failed: ${dpErr.message}`);

  // Spawn Design now so the re-mask sweep runs immediately. See the comment
  // in regenerateDesign — operator-initiated, in-page, unambiguous "do it now".
  await spawnAgentForOperatorAction("design", email);

  revalidatePath("/design");
}

/**
 * Hand-edit cycle: operator downloads an approved design, edits it locally
 * (Photoshop / Procreate / whatever), and uploads the modified PNG back. The
 * row's image_url flips to the new uploaded URL, the AI-generated original is
 * preserved in metadata.image_versions, and status returns to needs_review so
 * the operator approves the hand-edited version through the standard gate
 * before Listing publishes.
 *
 * Versioning, not replacement: every upload appends a new entry to
 * metadata.image_versions. On the FIRST hand-edit the AI original is also
 * stashed there (kind:"ai_original") so a future revert is one DB write away.
 *
 * Refuses anything but status='approved' so an in-flight or errored design
 * can't be silently overwritten. Operator can resume by re-approving the
 * design through the existing review queue.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type ImageVersion = {
  url: string;
  kind: "ai_original" | "hand_edit";
  uploaded_at: string;
  uploaded_by?: string;
};

export async function replaceDesignImage(formData: FormData): Promise<void> {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));

  const fileField = formData.get("image");
  if (!(fileField instanceof File) || fileField.size === 0) {
    throw new Error("No image file uploaded.");
  }
  if (fileField.type !== "image/png") {
    throw new Error(
      `Expected a transparent PNG (image/png), got '${fileField.type}'. ` +
        "The Printify pipeline downstream expects PNG; convert before uploading.",
    );
  }
  if (fileField.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Upload too large: ${(fileField.size / 1024 / 1024).toFixed(1)}MB ` +
        `exceeds the 25MB cap.`,
    );
  }

  const db = serviceClient();

  const { data: design, error: readErr } = await db
    .from("design_packages")
    .select("status, image_url, metadata, created_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw new Error(`Design read failed: ${readErr.message}`);
  if (!design) throw new Error("Design not found.");
  if (design.status !== "approved") {
    throw new Error(
      `Cannot replace image from status='${design.status}' ` +
        "(expected 'approved'). Approve the design first.",
    );
  }
  if (!design.image_url) {
    throw new Error("Design has no current image_url to version off of.");
  }

  // Versioned storage path: ISO timestamp + random suffix avoids collisions
  // if two uploads land in the same second. Suffix mirrors the Python
  // convention in packages/design/storage.py (which uses "-unmasked" etc.).
  const now = new Date();
  const isoStamp = now.toISOString().replace(/[:.]/g, "-");
  const randSuffix = Math.random().toString(36).slice(2, 8);
  const path = `${id}-edit-${isoStamp}-${randSuffix}.png`;

  const bytes = new Uint8Array(await fileField.arrayBuffer());
  const { error: uploadErr } = await db.storage
    .from("designs")
    .upload(path, bytes, {
      contentType: "image/png",
      upsert: false,
    });
  if (uploadErr) throw new Error(`Upload to storage failed: ${uploadErr.message}`);

  const { data: publicUrlData } = db.storage.from("designs").getPublicUrl(path);
  const newUrl = publicUrlData.publicUrl;

  // Read-modify-write on metadata. Single-operator system, no concurrent
  // writers on the same row, so a stale-read race here is not a concern.
  const existingMeta =
    design.metadata && typeof design.metadata === "object"
      ? (design.metadata as Record<string, unknown>)
      : {};
  const existingVersions = Array.isArray(existingMeta.image_versions)
    ? (existingMeta.image_versions as ImageVersion[])
    : [];

  const newEdit: ImageVersion = {
    url: newUrl,
    kind: "hand_edit",
    uploaded_at: now.toISOString(),
    uploaded_by: email,
  };
  const versions: ImageVersion[] =
    existingVersions.length === 0
      ? [
          // First hand-edit: stash the AI original first so future reverts
          // can find it without rebuilding from history.
          {
            url: design.image_url,
            kind: "ai_original",
            uploaded_at: design.created_at,
          },
          newEdit,
        ]
      : [...existingVersions, newEdit];

  const { error: updateErr } = await db
    .from("design_packages")
    .update({
      image_url: newUrl,
      status: "needs_review",
      error_message: null,
      metadata: { ...existingMeta, image_versions: versions },
    })
    .eq("id", id);
  if (updateErr) throw new Error(`Design update failed: ${updateErr.message}`);

  // No agent spawn — there's no Design subprocess to run. The hand-edited
  // image just sits in the review queue waiting for the operator's next
  // approval click, which is the existing gate before Listing claims it.
  revalidatePath("/design");
}

export async function retryDesign(formData: FormData) {
  const email = await assertOwner();
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

  // Retry is an operator click on the errored row — kick the agent now.
  await spawnAgentForOperatorAction("design", email);

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
  image_description: z.string().min(20).max(2000),
  image_model: z
    .enum(["fal_flux_pro", "fal_gpt_image_2", "fal_nano_banana_2"])
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
    image_description: formData.get("image_description"),
    image_model: (formData.get("image_model") ?? "fal_gpt_image_2") as
      | "fal_flux_pro"
      | "fal_gpt_image_2"
      | "fal_nano_banana_2",
    image_quality: (formData.get("image_quality") ?? "medium") as
      | "low"
      | "medium"
      | "high",
    color_palette: parsePaletteField(formData.get("color_palette")),
  });

  // Up-front compliance for FLUX prompts only — the agent's FluxPrompt
  // validator will reject the same way, but we surface it here for instant
  // feedback. gpt-image-2 and nano-banana-2 take natural English and skip
  // this check.
  if (parsed.image_model === "fal_flux_pro") {
    const lower = parsed.image_description.toLowerCase();
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
  // image_quality is consumed by gpt-image-2 (low/medium/high) and
  // nano-banana-2 (mapped → 0.5K/1K/2K resolutions in the Python client).
  // FLUX has no quality tier, so we persist NULL for it.
  const { error } = await db.from("trend_briefs").insert({
    niche: parsed.niche,
    status: "approved",
    image_description: parsed.image_description,
    image_model: parsed.image_model,
    image_quality:
      parsed.image_model === "fal_flux_pro" ? null : parsed.image_quality,
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
