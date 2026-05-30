"use server";

import { requireOwnerEmail } from "@/lib/auth";
import { generateLocalPalette } from "@/lib/palette";

/**
 * Returns 5 hex codes for the palette button. Primary source is Colormind.io
 * (free, no key, ML-curated palettes) with a local HSL-harmony fallback when
 * Colormind times out, rate-limits, or returns garbage. The fallback keeps
 * the "press space to cycle palettes" UX feeling instant even when the API
 * is flaky.
 *
 * Colormind's endpoint is HTTP-only, so this lives in a server action — the
 * dashboard is HTTPS and a direct browser fetch would be blocked as mixed
 * content. Auth-gated like every other action in this app.
 */
const COLORMIND_URL = "http://colormind.io/api/";
const FETCH_TIMEOUT_MS = 3000;

export async function generatePalette(): Promise<string[]> {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(COLORMIND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default" }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return generateLocalPalette();
    }
    const data = (await resp.json()) as { result?: number[][] };
    const triples = data.result;
    if (!Array.isArray(triples) || triples.length !== 5) {
      return generateLocalPalette();
    }
    const hexes = triples
      .map((rgb) => {
        if (!Array.isArray(rgb) || rgb.length !== 3) return null;
        const [r, g, b] = rgb;
        if (![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
          return null;
        }
        return `#${[r, g, b]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")}`;
      })
      .filter((h): h is string => h !== null);
    if (hexes.length !== 5) {
      return generateLocalPalette();
    }
    return hexes;
  } catch {
    clearTimeout(timer);
    // Network error, timeout, or JSON parse failure — local fallback never
    // throws, so the UX always has a palette to render.
    return generateLocalPalette();
  }
}
