"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";

const keySchema = z.string().min(1).max(120);

export async function setRuntimeFlag(formData: FormData) {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  const key = keySchema.parse(formData.get("key"));
  const raw = (formData.get("value") ?? "").toString();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Permit raw strings ("birefnet") without requiring the caller to wrap in quotes.
    value = raw;
  }

  const db = serviceClient();
  const { error } = await db
    .from("runtime_flags")
    .upsert(
      { key, value, updated_by: email, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(`Flag write failed: ${error.message}`);

  // The flag affects every section — invalidate everything cheap.
  ["/", "/scout", "/design", "/listings", "/ledger"].forEach((p) => revalidatePath(p));
}
