import { type NextRequest, NextResponse } from "next/server";
import { requireOwnerEmail } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase/server";
import { deleteListingImage } from "@presswork/shared";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/listings/[id]/etsy-images/[imageId]
 * Removes a single image from the live Etsy listing.
 * imageId is the Etsy listing_image_id (numeric).
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; imageId: string }> }
) {
  if (!(await requireOwnerEmail())) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id, imageId: imageIdStr } = await ctx.params;
  const imageId = Number(imageIdStr);
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return NextResponse.json(
      { error: "imageId must be a positive integer" },
      { status: 400 }
    );
  }

  const db = serviceClient();

  const { data: listing, error } = await db
    .from("listings")
    .select("etsy_listing_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const etsyListingId = listing.etsy_listing_id as number | null;
  if (!etsyListingId) {
    return NextResponse.json(
      { error: "Listing has no etsy_listing_id — not yet published to Etsy" },
      { status: 409 }
    );
  }

  try {
    await deleteListingImage(db, etsyListingId, imageId);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete image from Etsy";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
