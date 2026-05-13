import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { TrendBriefRow } from "./types";

/**
 * Queries for the Builder step.
 *
 * Pipeline position: Scout writes a brief at 'needs_review' → operator
 * approves on Scout page → status becomes 'needs_description' (the Builder
 * gate) → operator writes the image description in Builder → status flips
 * to 'approved' → Design claims and generates the image.
 */
export async function getBuilderQueue(): Promise<TrendBriefRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("trend_briefs")
    .select("*")
    .eq("status", "needs_description")
    .order("created_at", { ascending: true }); // oldest first — fairest queue
  if (error) {
    console.error("getBuilderQueue failed", error);
    return [];
  }
  return (data ?? []) as TrendBriefRow[];
}
