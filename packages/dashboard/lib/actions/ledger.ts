"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";

async function assertOwner() {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
}

const idSchema = z.string().uuid();

export async function retryOrder(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("orders")
    .update({ status: "logged", retry_count: 0, error_message: null })
    .eq("id", id);
  if (error) throw new Error(`Retry failed: ${error.message}`);
  revalidatePath("/ledger");
}
