"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";

async function assertOwner() {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
  return email;
}

const idSchema = z.string().uuid();

export async function approveListing(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // Re-fetch the listing to confirm it's still at needs_review — guards
  // against a stale tab approving something that already moved on.
  const { data: row } = await db
    .from("listings")
    .select("status, title, description, tags")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}'`);
  }

  const { error } = await db
    .from("listings")
    .update({
      status: "pending_publish",
      error_message: null,
      retry_count: 0,
    })
    .eq("id", id)
    .eq("status", "needs_review"); // optimistic concurrency guard
  if (error) throw new Error(`Approve failed: ${error.message}`);

  await db.from("llm_usage").insert({
    agent: "listing",
    provider: "etsy",
    operation: "manual_approve",
    metadata: { listing_id: id, approver: email },
  });

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function rejectListing(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const reason = (formData.get("reason") ?? "").toString().slice(0, 500);
  const db = serviceClient();

  // Re-fetch the listing to confirm it's still at needs_review — guards
  // against a stale tab rejecting something that already moved on
  // (publishing, active, or another terminal state). Mirrors the
  // approveListing guard at the top of this file (AUDIT_4 H3).
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot reject from status='${row.status}'`);
  }

  const { error } = await db
    .from("listings")
    .update({
      status: "error",
      error_message: `manual reject (${email}): ${reason || "no reason given"}`,
    })
    .eq("id", id)
    .eq("status", "needs_review"); // optimistic concurrency guard
  if (error) throw new Error(`Reject failed: ${error.message}`);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function regenerateCopy(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      title: null,
      description: null,
      tags: null,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Regenerate copy failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function recreatePrintifyProduct(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      printify_product_id: null,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Recreate Printify product failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function retryListing(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      retry_count: 0,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Retry failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}
