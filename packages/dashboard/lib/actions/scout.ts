"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import {
  generateNicheBrief,
  GenerateNicheError,
  type GeneratedNicheBrief,
} from "@/lib/scout/generate-niche";
async function assertOwner() {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
  return email;
}

const idSchema = z.string().uuid();

export async function approveBrief(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("trend_briefs")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Brief not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}' (expected 'needs_review')`);
  }

  // Scout-approve hands the brief to Builder; Builder writes the image
  // description and is the one that flips status='approved' to release the
  // brief into Design's claim queue.
  const { error } = await db
    .from("trend_briefs")
    .update({ status: "needs_description", error_message: null })
    .eq("id", id)
    .eq("status", "needs_review"); // optimistic concurrency
  if (error) throw new Error(`Approve failed: ${error.message}`);

  revalidatePath("/scout");
  revalidatePath("/builder");
  revalidatePath("/");
}

export async function regenerateBrief(formData: FormData) {
  // "Regen" for a brief means: this niche's reading is wrong, delete it and
  // I'll re-run Scout for a fresh take. Per-brief re-scout is Phase 2.
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // Refuse if a design references it — same safety as deleteBrief.
  const { count, error: countErr } = await db
    .from("design_packages")
    .select("id", { count: "exact", head: true })
    .eq("trend_brief_id", id);
  if (countErr) throw new Error(`Reference check failed: ${countErr.message}`);
  if ((count ?? 0) > 0) {
    throw new Error(
      `Cannot regen: ${count} design(s) reference this brief. Delete the design first.`,
    );
  }

  const { error } = await db.from("trend_briefs").delete().eq("id", id);
  if (error) throw new Error(`Regen failed: ${error.message}`);
  revalidatePath("/scout");
}

export async function retryBrief(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("trend_briefs")
    .update({ status: "pending", retry_count: 0, error_message: null })
    .eq("id", id);
  if (error) throw new Error(`Retry failed: ${error.message}`);
  revalidatePath("/scout");
}

export async function deleteBrief(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // design_packages.trend_brief_id → trend_briefs(id) is NO ACTION. Refuse if
  // any design references this brief so we give a clear error instead of an
  // FK violation. To cascade, delete the design on the Design page first.
  const { count: designCount, error: countErr } = await db
    .from("design_packages")
    .select("id", { count: "exact", head: true })
    .eq("trend_brief_id", id);
  if (countErr) throw new Error(`Design reference check failed: ${countErr.message}`);
  if ((designCount ?? 0) > 0) {
    throw new Error(
      `Cannot delete: ${designCount} design(s) reference this brief. Delete the design first from the Design page.`,
    );
  }

  const { error } = await db.from("trend_briefs").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);

  revalidatePath("/scout");
}

// Statuses where an in-flight edit is meaningful. While a brief is being
// claimed by Design (processing) or already done (done), edits are rejected —
// the operator should clone or regen instead of mutating mid-pipeline.
const EDITABLE_BRIEF_STATUSES = new Set([
  "pending",
  "needs_review",
  "needs_description",
  "approved",
  "error",
]);

const EditBriefSchema = z.object({
  id: z.string().uuid(),
  niche: z.string().min(2).max(120),
  style_keywords: z.array(z.string()).default([]),
  top_tags: z.array(z.string()).max(13).default([]),
  price_target_usd: z.number().min(0).max(1000).nullable(),
  color_palette: z.array(z.string()).default([]),
});

export async function editBrief(formData: FormData): Promise<void> {
  await assertOwner();
  const priceRaw = formData.get("price_target_usd");
  const priceValue =
    typeof priceRaw === "string" && priceRaw.trim() !== ""
      ? Number(priceRaw)
      : null;
  const parsed = EditBriefSchema.parse({
    id: formData.get("id"),
    niche: formData.get("niche"),
    style_keywords: parseList(formData.get("style_keywords")?.toString() ?? null),
    top_tags: parseList(formData.get("top_tags")?.toString() ?? null),
    price_target_usd: priceValue,
    color_palette: parseList(formData.get("color_palette")?.toString() ?? null),
  });

  const db = serviceClient();

  // Guard: verify the brief is in an editable state. The brief.status check
  // is racy against Design's claim, but rejecting a stale update is better
  // than silently overwriting a row another agent is working on.
  const { data: current } = await db
    .from("trend_briefs")
    .select("status")
    .eq("id", parsed.id)
    .maybeSingle();
  if (!current) throw new Error("Brief not found");
  if (!EDITABLE_BRIEF_STATUSES.has(current.status as string)) {
    throw new Error(
      `Cannot edit brief in status='${current.status}'. Wait for it to leave processing/done first.`,
    );
  }

  const { error } = await db
    .from("trend_briefs")
    .update({
      niche: parsed.niche,
      style_keywords: parsed.style_keywords.length > 0 ? parsed.style_keywords : null,
      top_tags: parsed.top_tags.length > 0 ? parsed.top_tags : null,
      price_target_usd: parsed.price_target_usd,
      color_palette: parsed.color_palette.length > 0 ? parsed.color_palette : null,
    })
    .eq("id", parsed.id);
  if (error) throw new Error(`Edit failed: ${error.message}`);

  revalidatePath("/scout");
  revalidatePath("/builder");
}

const InjectBriefSchema = z.object({
  niche: z.string().min(2).max(120),
  style_keywords: z.array(z.string()).default([]),
  top_tags: z.array(z.string()).max(13).default([]),
  price_target_usd: z.number().min(0).max(1000).optional(),
  color_palette: z.array(z.string()).default([]),
});

function parseList(input: string | null): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Used by the dashboard's "Generate niche" button. Discriminated return so
// the client component can render the error inline — Claude hiccups and
// schema mismatches are expected-fallible, not error-boundary-worthy.
export type GenerateBriefResult =
  | { ok: true; brief: GeneratedNicheBrief }
  | { ok: false; error: string };

const hintSchema = z
  .string()
  .trim()
  .max(200, "Hint must be 200 characters or fewer");

export async function generateBriefDraft(rawHint: string): Promise<GenerateBriefResult> {
  await assertOwner();
  const parsed = hintSchema.safeParse(rawHint ?? "");
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid hint" };
  }
  try {
    const brief = await generateNicheBrief(parsed.data || null);
    return { ok: true, brief };
  } catch (err) {
    const message =
      err instanceof GenerateNicheError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `Generate failed: ${message}` };
  }
}

export async function injectBrief(formData: FormData) {
  await assertOwner();
  const priceRaw = formData.get("price_target_usd");
  const parsed = InjectBriefSchema.parse({
    niche: formData.get("niche"),
    style_keywords: parseList(formData.get("style_keywords")?.toString() ?? null),
    top_tags: parseList(formData.get("top_tags")?.toString() ?? null),
    price_target_usd: priceRaw ? Number(priceRaw) : undefined,
    color_palette: parseList(formData.get("color_palette")?.toString() ?? null),
  });

  const db = serviceClient();
  // Land manually-injected briefs in the review queue so the operator sees
  // them immediately and can approve from the same page. 'pending' is a dead
  // state post-migration-021 (review gates) — Design only claims 'approved'
  // and the review queue card only renders 'needs_review'.
  //
  // prompt_constraint is no longer set from Scout — it moves to the Builder
  // step (between Scout-approve and Design-generate). The DB column stays
  // for back-compat and for Builder to write into.
  const { error } = await db.from("trend_briefs").insert({
    ...parsed,
    status: "needs_review",
    claude_analysis: { source: "dashboard_manual_inject" },
  });
  if (error) throw new Error(`Inject failed: ${error.message}`);
  revalidatePath("/scout");
  revalidatePath("/builder");
  // The Design page's notifier tracks upstream brief counts — flush it so the
  // muted "briefs awaiting approval upstream" row updates without waiting for
  // the next poll tick.
  revalidatePath("/design");
}
