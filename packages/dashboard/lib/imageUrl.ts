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
