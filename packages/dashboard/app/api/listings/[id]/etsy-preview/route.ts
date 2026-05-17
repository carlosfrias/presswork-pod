import { type NextRequest, NextResponse } from "next/server";
import { getEtsyPayloadPreview } from "@/lib/queries/etsy-preview";

export const dynamic = "force-dynamic";

/**
 * Returns the exact set of payloads the listing publisher would send to
 * Etsy for this listing if the operator approves it. Read-only; no Etsy
 * calls. Useful for sanity-checking what mock-mode is faking, and for
 * curl-friendly inspection of the publish flow before flipping the switch.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const preview = await getEtsyPayloadPreview(id);
  return NextResponse.json(preview);
}
