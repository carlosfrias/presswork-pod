/**
 * Append a cache-busting query string to a design image URL so a regen's
 * new bytes actually show up in the browser without a hard refresh.
 *
 * Why this exists: Supabase Storage uploads from the Design agent use a
 * constant path per design (`<design_id>.png` with `upsert: true` — see
 * packages/design/storage.py). Every regen overwrites the same file at the
 * same URL. The browser's image cache keys on URL — so after a successful
 * regen the `image_url` column is byte-for-byte identical to what it was
 * before, the realtime UPDATE fires `router.refresh()` correctly, but the
 * <img src> still resolves to the cached prior bytes.
 *
 * Fix: append `?v=<updated_at>` to the rendered src. The DB column changes
 * on every row write, so each regen produces a unique cache key automatically
 * while the underlying storage URL stays put.
 *
 * USE AT RENDER SITES ONLY (<img src>, Lightbox src). Download links must
 * keep the raw URL so the filename and `download` attribute work cleanly —
 * there's no cache issue on downloads anyway since each click is a fresh
 * fetch with `Content-Disposition`.
 */
export function withCacheBuster(
  url: string | null | undefined,
  version: string | number | null | undefined,
): string | null {
  if (!url) return null;
  if (version == null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(String(version))}`;
}

export type TransformOpts = {
  width: number;
  height?: number;
  quality?: number;
  /** Supabase resize mode. "cover" (default) crops to fill; "contain" letterboxes. */
  resize?: "cover" | "contain" | "fill";
};

/**
 * Rewrite a Supabase Storage object URL to the image transformation endpoint
 * so the CDN serves a resized, WebP-compressed version instead of the raw
 * full-resolution PNG. Non-Supabase URLs (Printify CDN, Etsy) are returned
 * unchanged, so it is safe to call this on any image URL.
 *
 * Always pass both width AND height for square thumbnails. Design PNGs are
 * stored as 4500×5400 print canvases (15"×18" @ 300dpi). Supplying only
 * width leaves height at 5400px — the transform applies width correctly but
 * does not auto-scale the height when the source has non-square dimensions.
 *
 * USE AT RENDER SITES ONLY. Download links must keep the raw `/object/public/`
 * URL — the transform endpoint does not honour `?download=`.
 */
export function withTransform(
  url: string | null | undefined,
  opts: TransformOpts,
): string | null {
  if (!url) return null;
  // Requires Supabase Pro. When the flag is off, return the original URL so
  // the dashboard works normally on the free tier without any component changes.
  if (process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS_ENABLED !== "true") return url;
  // Only transform Supabase Storage object URLs — Printify CDN and Etsy URLs pass through.
  if (!url.includes("/storage/v1/object/public/")) return url;
  const u = new URL(url);
  u.pathname = u.pathname.replace(
    "/storage/v1/object/public/",
    "/storage/v1/render/image/public/",
  );
  u.searchParams.set("width", String(opts.width));
  if (opts.height != null) u.searchParams.set("height", String(opts.height));
  if (opts.quality != null) u.searchParams.set("quality", String(opts.quality));
  if (opts.resize != null) u.searchParams.set("resize", opts.resize);
  return u.toString();
}

/**
 * Force the browser to download (not navigate to) an image URL.
 *
 * The HTML `download` attribute is silently ignored for cross-origin URLs
 * unless the response carries `Content-Disposition: attachment`. Supabase
 * Storage public URLs DO respect a `?download=<filename>` query param —
 * the storage server adds the disposition header server-side. Using that
 * here means the operator's click triggers an actual download, not a new-
 * tab navigation, even though the storage origin is different from the
 * dashboard origin.
 *
 * For non-Supabase URLs the param is harmless (most servers ignore unknown
 * query params); the worst case is a tab opening, which is the current
 * behavior. Pair this helper with an `<a href={withDownload(url, name)}>`
 * (no `target` attribute) for a clean download.
 */
export function withDownload(
  url: string | null | undefined,
  filename: string,
): string | null {
  if (!url) return null;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}download=${encodeURIComponent(filename)}`;
}
