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
// SSRF vector (e.g. http://169.254.169.254/...). Rather than allowlist image-host
// domains (brittle — e.g. Dynamic Mockups renders live on a rotating S3 bucket,
// not *.dynamicmockups.com), the POST handler authorizes against OUR OWN DATA:
// the URL must already be one of THIS listing's known images (its design PNG or
// a generated mockup). That guarantees we only ever re-upload assets we produced
// and is immune to any mockup provider changing CDNs. https is still required
// here as a basic guard before the server-side fetch.
const PostBodySchema = z.object({
  imageUrl: z
    .string()
    .url()
    .refine(
      (raw) => {
        try {
          return new URL(raw).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "imageUrl must be an https URL" }
    ),
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
    .select(
      `etsy_listing_id, title,
       design_packages:design_packages!listings_design_package_id_fkey(
         image_url, mockup_urls
       )`
    )
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

  // Authorize the URL against this listing's own image pool: the design PNG
  // plus every generated mockup. Anything else is rejected — this is the SSRF
  // guard (only assets we produced can be fetched server-side) and also stops
  // an unrelated image being added to the listing. The embedded relation comes
  // back typed as an array, so cast via unknown (the pattern used elsewhere in
  // the dashboard for to-one joins).
  const design = (
    listing as unknown as {
      design_packages?: {
        image_url: string | null;
        mockup_urls: string[] | null;
      } | null;
    }
  ).design_packages;
  const allowedImageUrls = new Set<string>(
    [design?.image_url ?? null, ...(design?.mockup_urls ?? [])].filter(
      (u): u is string => typeof u === "string" && u.length > 0
    )
  );
  if (!allowedImageUrls.has(imageUrl)) {
    return NextResponse.json(
      {
        error:
          "imageUrl is not part of this listing's design — only its design image or generated mockups can be added.",
      },
      { status: 400 }
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
