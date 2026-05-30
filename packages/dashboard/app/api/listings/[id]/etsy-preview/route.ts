import { type NextRequest, NextResponse } from "next/server";
import { requireOwnerEmail } from "@/lib/auth";
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
  // Defense-in-depth: don't rely solely on the middleware matcher to gate
  // this route. A matcher edit or PUBLIC_PATHS change must not silently
  // expose the Etsy publish payload for arbitrary listing ids.
  if (!(await requireOwnerEmail())) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { id } = await ctx.params;
  const preview = await getEtsyPayloadPreview(id);
  return NextResponse.json(preview);
}
