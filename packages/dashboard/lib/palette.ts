/**
 * Local color-palette generator. Used as a fast-path / fallback alongside the
 * Colormind server action — generates 5 harmonious hex codes via HSL rotation
 * around a randomly-picked base hue. Quality is "good enough for screen-print
 * design briefs"; for richer ML-curated palettes see lib/actions/palette.ts.
 */

export const PALETTE_SIZE = 5;

const HARMONY_RULES = [
  "analogous",
  "complementary",
  "split_complementary",
  "triadic",
  "tetradic",
  "monochromatic",
] as const;
type HarmonyRule = (typeof HARMONY_RULES)[number];

export function generateLocalPalette(seed?: number): string[] {
  // Deterministic when seed is provided, otherwise random. Seed support is
  // exercised by tests; the UI just calls generateLocalPalette() with no arg.
  const rand = seed != null ? mulberry32(seed) : Math.random;
  const baseHue = Math.floor(rand() * 360);
  const rule = HARMONY_RULES[Math.floor(rand() * HARMONY_RULES.length)];
  const hues = rotateHuesFor(rule, baseHue);
  // Hand-tuned saturation/lightness ranges — high enough for ink-on-fabric
  // contrast, low enough to avoid neon-CRT-looking palettes.
  return hues.map((h, i) => {
    const sat = 55 + Math.floor(rand() * 30); // 55–85
    const light = 35 + Math.floor((i / PALETTE_SIZE) * 35) + Math.floor(rand() * 10);
    return hslToHex(h, sat, Math.min(75, light));
  });
}

function rotateHuesFor(rule: HarmonyRule, baseHue: number): number[] {
  // Returns PALETTE_SIZE hues spaced by the chosen harmony rule.
  const wrap = (h: number) => ((h % 360) + 360) % 360;
  switch (rule) {
    case "analogous":
      return [-30, -15, 0, 15, 30].map((d) => wrap(baseHue + d));
    case "complementary":
      return [0, 20, 180, 200, 160].map((d) => wrap(baseHue + d));
    case "split_complementary":
      return [0, 30, 150, 210, 330].map((d) => wrap(baseHue + d));
    case "triadic":
      return [0, 120, 240, 60, 300].map((d) => wrap(baseHue + d));
    case "tetradic":
      return [0, 90, 180, 270, 45].map((d) => wrap(baseHue + d));
    case "monochromatic":
      return [0, 0, 0, 0, 0].map(() => wrap(baseHue));
  }
}

// Standard HSL → RGB → hex conversion. h in [0,360), s and l in [0,100].
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Tiny deterministic PRNG so tests don't depend on Math.random.
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Accepts "#abc", "#aabbcc", "AABBCC", "abc", strips whitespace, returns
 * normalized "#aabbcc" lowercase. Returns null when not a hex color. */
export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed.split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9a-f]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  return null;
}

export function isValidHex(raw: string): boolean {
  return normalizeHex(raw) !== null;
}
