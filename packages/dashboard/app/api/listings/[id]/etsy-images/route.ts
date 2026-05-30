import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerEmail } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase/server";
import {
  getListingImages,
  uploadListingImage,
  getListingImageCount,
} from "@presswork/shared";

export const dynamic = "force-dynamic";

/** GET /api/listings/[id]/etsy-images — returns the images currently live on the Etsy listing. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!(await requireOwnerEmail())) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id } = await ctx.params;
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
    const images = await getListingImages(db, etsyListingId);
    return NextResponse.json({ images });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch Etsy images";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// uploadListingImage fetches imageUrl server-side, so an unconstrained URL is an
// SSRF vector (e.g. http://169.254.169.254/...). Restrict to https on the hosts we
// actually serve listing images from: Supabase Storage (design PNG) and the mockup
// CDNs (Printify, Dynamic Mockups).
const TRUSTED_IMAGE_HOST_SUFFIXES = [
  ".supabase.co",
  ".printify.com",
  ".dynamicmockups.com",
] as const;

function isTrustedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return TRUSTED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
  );
}

const PostBodySchema = z.object({
  imageUrl: z
    .string()
    .url()
    .refine(isTrustedImageUrl, {
      message:
        "imageUrl must be an https URL on a trusted image host (Supabase Storage, Printify, or Dynamic Mockups)",
    }),
  rank: z.number().int().positive().optional(),
  altText: z.string().max(250).optional(),
});

/** POST /api/listings/[id]/etsy-images — adds an image to the live Etsy listing. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!(await requireOwnerEmail())) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { imageUrl, rank: requestedRank, altText } = parsed.data;

  const db = serviceClient();

  const { data: listing, error } = await db
    .from("listings")
    .select("etsy_listing_id, title")
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
    // Default rank to current count + 1 so the new image appends to the end.
    const rank =
      requestedRank ?? (await getListingImageCount(db, etsyListingId)) + 1;

    const resolvedAltText =
      altText ??
      (listing.title ? `Product photo: ${listing.title}` : undefined);

    await uploadListingImage(db, etsyListingId, imageUrl, {
      rank,
      altText: resolvedAltText,
    });

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to upload image to Etsy";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
