/**
 * Style catalog used by the Builder and Design review/regen flows.
 *
 * Each entry is a single click for the operator that injects a concrete,
 * opinionated rendering directive into either Builder's Claude call or
 * Design's regen prompt textarea. The goal is to break the "everything looks
 * samey" failure mode by giving the operator a fast way to lock the FLUX
 * (or gpt-image-2) render into a distinct visual register.
 *
 * The directives are deliberately specific:
 *   - Named medium (linocut, etching, oil painting, screen print)
 *   - Concrete line/tone/palette language ("flat solid fills, no gradients,
 *     no shading", "fine parallel hatching", "sfumato")
 *   - Historical reference points where useful ("Edward Bawden", "Vermeer")
 *     — composition/style anchors, not brand/IP copying
 *
 * Adding a style: append to STYLE_OPTIONS, give it a stable `id`, a 1-line
 * `blurb` (visible in chip tooltips), and a multi-line `directive` that
 * names medium + line + palette + composition.
 *
 * Order: most common / most useful first.
 */

export interface StyleOption {
  id: StyleId;
  label: string;
  blurb: string;
  directive: string;
}

export type StyleId =
  // Print media
  | "screen_print"
  | "woodblock"
  | "lino_cut"
  | "risograph"
  // Drawing / illustration
  | "illustration"
  | "watercolor_sketch"
  | "stipple_pointillism"
  | "vintage_science_illustration"
  // Line / graphic
  | "etching"
  | "black_and_white"
  | "tattoo_flash"
  | "blueprint"
  | "pixel_art"
  // Painterly / decorative
  | "classical"
  | "art_nouveau"
  | "stained_glass"
  // Mixed media
  | "collage_cut_paper"
  | "soviet_propaganda";

export const STYLE_OPTIONS: readonly StyleOption[] = [
  // ─── Print media ────────────────────────────────────────────────────────
  {
    id: "screen_print",
    label: "Screen Print",
    blurb: "Flat color fills, bold black outlines, no gradients.",
    directive:
      "Render as a hand-pulled screen print. Two to four flat solid color fills with NO gradients, NO airbrush, NO soft shading. Bold confident black outlines on every shape — varied line weight permitted, but every contour is decisively drawn. Strong silhouette that reads at six inches across. Halftone dot texture allowed for limited tonal depth, but the dominant treatment is flat color separation. Aesthetic register: 1990s indie band tour poster, classic Aaron Draplin / Mike Perry territory. Negative space is plain background.",
  },
  {
    id: "woodblock",
    label: "Woodblock",
    blurb: "Japanese ukiyo-e — flat color areas, key-block outline.",
    directive:
      "Render as a Japanese ukiyo-e woodblock print. Flat color areas with NO gradients and NO modeling, bounded by a confident black key-block outline that defines every shape. Restrained traditional palette: indigo blue, vermilion, ochre, soft pink, sumi black, mineral green — pick a tight selection from these. Bold compositional cropping, asymmetric balance, large areas of negative-space sky or empty foreground. Wood-grain texture optional in flat fields. Aesthetic register: Hokusai, Hiroshige, Utamaro — 18th–19th century floating-world prints, decisively two-dimensional.",
  },
  {
    id: "lino_cut",
    label: "Lino Cut",
    blurb: "Hand-carved chunky marks, high contrast, no fine line.",
    directive:
      "Render as a hand-pulled linocut block print. Pure high-contrast black-on-cream (or single dark color on cream) with chunky carved-mark texture throughout — visible chisel cuts, irregular knife marks, hand-pressed registration imperfections. No fine line, no smooth curves, no airbrush. Negative-space cuts inside black masses suggest form and texture. Look like Edward Bawden, Sybil Andrews, or Clare Leighton — folk-modern, woodcut-adjacent, deeply handmade. Background is the unprinted paper.",
  },
  {
    id: "risograph",
    label: "Risograph",
    blurb: "Bright spot colors, visible misregistration, grain.",
    directive:
      "Render as a modern Riso print. Two or three spot-color separations layered with deliberate misregistration where colors overlap into a third hue. Visible coarse grain texture throughout every fill — no smooth surfaces. Bright limited palette of bold Riso inks: fluorescent pink, federal blue, sunflower yellow, mint, aqua, or teal — pick two or three only, and let their overlaps create the secondary colors. Subtle halftone-dot pattern in each color separation. Composition feels handmade, zine-adjacent, intentionally imperfect.",
  },
  // ─── Drawing / illustration ─────────────────────────────────────────────
  {
    id: "illustration",
    label: "Illustration",
    blurb: "Editorial line work, restrained palette, soft tonal depth.",
    directive:
      "Render as contemporary editorial illustration. Confident hand-drawn line work with varied weight, light cross-hatching or stippling for form. Restrained 4–6 color palette built around soft mid-tones — warm earth tones, dusty pastels, muted accents. Depth comes from tonal layering and selective shadow, NOT photographic gradient or rendering. Aesthetic register: New Yorker / Olimpia Zagnoli / Malika Favre — neither cartoon nor photoreal, sits in between.",
  },
  {
    id: "watercolor_sketch",
    label: "Watercolor Sketch",
    blurb: "Loose transparent washes, visible paper, partial drawing.",
    directive:
      "Render as a loose watercolor sketch. Soft transparent washes bleed into one another on visible cold-press paper texture — never opaque, never covering. Pencil under-drawing partially visible through the washes; some passages deliberately left as bare paper-white. Restrained palette of cool blues, warm sienna, soft greens, and dusty earth tones — picked from observation, not saturated. Deliberate looseness: wet edges, granulation, occasional accidental drip or pooling. Composition reads as observed and unfinished in the best way, like a travel-journal page or a field study.",
  },
  {
    id: "stipple_pointillism",
    label: "Stipple / Pointillism",
    blurb: "Form built entirely from dots — density carries tone.",
    directive:
      "Render the entire image from dots only. Form, volume, and shadow are built ONLY by varying dot density — denser dots for shadow, sparser dots for midtone, paper-white for highlight. No outlines, no flat fills, no continuous tone, no hatching. Pick ONE register and commit: either monochrome ink stipple engraving (black or dark sepia dots on cream), or pure spectral pointillism (small adjacent dots of pure hue that mix optically). Aesthetic register: 19th-century scientific stipple engraving for monochrome; Seurat, Signac, Cross for color pointillism.",
  },
  {
    id: "vintage_science_illustration",
    label: "Vintage Science Illustration",
    blurb: "Victorian naturalist plate — fine ink + delicate wash.",
    directive:
      "Render as a 19th-century scientific plate. Fine ink line work building structure and form via precise hatching and cross-hatching, overlaid with delicate transparent watercolor washes in muted naturalist colors — sage greens, pale ochres, dusky rose, soft umber, ivory. Subject rendered with anatomical precision and labeling-diagram clarity, often shown in multiple views (side, top, detail magnification). Cream paper background with subtle aged texture and a thin engraved frame line. Latinate-style label text or numbered key permitted as a design element. Aesthetic register: Audubon's Birds of America, Ernst Haeckel's Kunstformen der Natur, Maria Sibylla Merian — Victorian curiosity-cabinet authority.",
  },
  // ─── Line / graphic ─────────────────────────────────────────────────────
  {
    id: "etching",
    label: "Etching",
    blurb: "Fine parallel hatching, monochrome ink, classical line work.",
    directive:
      "Render as a copper-plate etching. Form, volume, and shadow are built ENTIRELY from fine parallel hatching and cross-hatching — no solid black masses, no flat fills, no halftone dots. Monochrome ink (black or dark sepia) on warm cream / ivory paper. Tightly controlled line work with deliberate density variation: dense hatching for shadow, sparse hatching for midtones, paper for highlight. Plate-mark border permitted. Aesthetic register: 17th–19th century Goya, Dürer, Rembrandt, Käthe Kollwitz.",
  },
  {
    id: "black_and_white",
    label: "Black & White",
    blurb: "Pure black/white, no gray, decisive negative space.",
    directive:
      "Render in pure black and white only — no grays, no halftone, no gradients, no shading transitions. Form is built from confident solid black shapes against white (or white shapes against solid black). Decisive negative space carries the composition. Strong silhouette, bold ink-on-paper aesthetic. Think Frank Miller's Sin City, Stanley Donwood, Aaron Draplin's monochrome work — confident shapes, no rendering, no softness.",
  },
  {
    id: "tattoo_flash",
    label: "Tattoo Flash",
    blurb: "American Traditional — bold outlines, four-color flat fills.",
    directive:
      "Render as a single icon pulled from a vintage American Traditional tattoo flash sheet. Bold even-weight black outlines around every shape, with no fine interior line. Strictly limited fill palette of solid colors: pillar-box red, forest green, sunshine yellow, ocean blue, and black — pick from these, no shading beyond a single mid-tone hatch where absolutely needed. Classic flash-sheet motif vocabulary: rope banners with text, daggers, roses, swallows, anchors, hearts, dice, panthers. Composition is one centered icon, no scenery, posed flat to the picture plane. Aesthetic register: Sailor Jerry, Ed Hardy, mid-20th-century shop walls.",
  },
  {
    id: "blueprint",
    label: "Blueprint",
    blurb: "White line on cyanotype blue — technical drawing.",
    directive:
      "Render as a cyanotype architectural blueprint. Solid deep Prussian-blue background with the entire image drawn in clean white line work — no other colors permitted. Precise technical line weights: thin construction lines for hidden detail, medium for primary outlines, thinnest for hatched cross-section fill. Engineering-drawing flourishes welcome: dimension arrows with measurements, callout circles with numbers, isometric or orthographic projection, exploded-view annotations. Composition reads like a draftsman's plate — measured, labeled, deliberate.",
  },
  {
    id: "pixel_art",
    label: "Pixel Art",
    blurb: "Crisp pixel grid, limited palette, no anti-aliasing.",
    directive:
      "Render as 16-bit-era pixel art. Crisp pixel grid with NO anti-aliasing — every edge is a hard right-angle staircase between two colors. Strictly limited palette of 8–16 colors total, often built as hue-shifted color ramps (a single ramp for skin shades the warm shadows toward purple rather than just darkening). Two- or three-pixel-wide outline in the darkest shade of each color ramp. Deliberate dithering patterns (checker, ordered) for soft tonal transitions — never smooth gradients. Aesthetic register: SNES JRPG sprites, mid-1990s point-and-click adventures, modern indie homages like Hyper Light Drifter or Owlboy.",
  },
  // ─── Painterly / decorative ─────────────────────────────────────────────
  {
    id: "classical",
    label: "Classical",
    blurb: "Sfumato oil painting, chiaroscuro, anatomical attention.",
    directive:
      "Render as a classical European oil painting from the 15th–18th century. Sfumato modeling — soft tonal transitions between light and shadow, no hard edges, atmospheric depth. Restrained warm palette: burnt umber, raw sienna, ochre, deep crimson, lead white, ivory black. Chiaroscuro lighting: single directional light source, deep velvety shadows on the opposite side. Visible brushwork in midtones; smooth blending in faces and flesh. Subject posed with classical gravitas, anatomically careful, rendered with the attention given to human (or animal) form by Vermeer, Rembrandt, Caravaggio, Velázquez. Background is a deep tonal field, not a scene.",
  },
  {
    id: "art_nouveau",
    label: "Art Nouveau",
    blurb: "Sinuous organic curves, decorative borders, muted gold.",
    directive:
      "Render in the Art Nouveau decorative style of the 1890s–1910s. Sinuous flowing whiplash curves throughout — every line is organic, unbroken, and slightly attenuated. Stylized natural ornament fills the composition: twisting vines, peacock feathers, flowing hair turning into smoke, stylized petals and tendrils framing the subject. Restrained but luxurious palette of muted gold, deep teal, soft rose, ivory, and burgundy. Decorative arched or panel-shaped border integrated into the design — the frame is part of the composition. Aesthetic register: Alphonse Mucha, Aubrey Beardsley, Eugène Grasset — poster-art, ornamental, deliberately two-dimensional.",
  },
  {
    id: "stained_glass",
    label: "Stained Glass",
    blurb: "Thick black lead lines, flat translucent jewel tones.",
    directive:
      "Render as a stained-glass window. Composition is divided into discrete flat shapes by thick black lead lines (the cames) that form the entire structural skeleton. Each enclosed shape is filled with a single saturated translucent jewel-tone color — cobalt blue, ruby red, emerald green, amber gold, deep amethyst, sun yellow — no gradients, no modeling, no shading inside any cell. The lead-line network reads as a graphic skeleton holding the color field together. Aesthetic register: medieval cathedral rose windows, Tiffany lamps, Frank Lloyd Wright prairie-style art glass — geometric, devotional, luminous.",
  },
  // ─── Mixed media ────────────────────────────────────────────────────────
  {
    id: "collage_cut_paper",
    label: "Collage / Cut Paper",
    blurb: "Layered cut-paper shapes, visible edges, tactile texture.",
    directive:
      "Render as a hand-cut paper collage. Composition built from layered paper shapes with visibly scissor-cut edges — slightly irregular, occasionally torn rather than cut clean. Each paper layer is a flat textured field (visible fiber, brushed-on color, or solid construction-paper saturation) with NO internal modeling, NO gradient, NO smooth fills. Subtle drop-shadow cast between layers where they overlap suggests gentle depth. Restrained tactile palette: muted naturalist greens, dusty terracotta, cream, charcoal, periwinkle. Aesthetic register: Eric Carle's children's books, Henri Matisse's late cut-outs, Lotte Reiniger silhouette films — handmade, warm, deliberately imperfect.",
  },
  {
    id: "soviet_propaganda",
    label: "Soviet Propaganda",
    blurb: "Constructivist poster — red/black/cream, heroic angles.",
    directive:
      "Render as a 1920s–1930s Soviet constructivist poster. Bold geometric composition built from triangles, rectangles, and aggressive diagonal axes. Strictly limited palette: cadmium red, deep black, and warm off-white only — no other colors permitted. Strong perspective cropping with the subject silhouetted from a low heroic angle. Photomontage texture and high-contrast halftone permitted; heavy sans-serif geometric Cyrillic-flavored type integrated as a structural design element. Aesthetic register: Rodchenko, El Lissitzky, Klutsis, Stenberg brothers — confrontational, monumental, ideological.",
  },
] as const;

export const STYLE_IDS = STYLE_OPTIONS.map((s) => s.id);

export function getStyle(id: string | null | undefined): StyleOption | null {
  if (!id) return null;
  return STYLE_OPTIONS.find((s) => s.id === id) ?? null;
}

/**
 * Sentinel that marks an injected style block inside a Design regen prompt
 * textarea. Used to detect-and-replace prior style blocks idempotently so
 * the operator can switch styles without piling up directives. The bracket
 * syntax is plain text and harmless to FLUX / gpt-image-2 — they treat the
 * sentinel as just another phrase in the prompt body.
 */
export const STYLE_BLOCK_SENTINEL = "\n\n[STYLE LOCK]\n";

/**
 * Normalize line endings to LF before any sentinel-based detect/split. The
 * persisted fal_prompt may contain CRLF if it was last written via an HTML
 * form submission (textareas serialize newlines as CRLF per spec). The
 * sentinel is defined with LF only, so CRLF input silently breaks split
 * and detect-and-replace devolves into append-only — that's how multiple
 * [STYLE LOCK] blocks accumulate. We normalize at every entry point so
 * defense-in-depth holds even if some upstream caller forgets to scrub.
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Insert or replace the style block in a Design regen prompt textarea.
 *
 * - Strips any existing block first (split on sentinel, keep head).
 * - When `styleId` is null, returns the stripped prompt (operator deselected
 *   the style — remove any prior injection).
 * - Otherwise appends the new sentinel + directive.
 */
export function applyStyleToPrompt(
  prompt: string,
  styleId: StyleId | null,
): string {
  const normalized = normalizeNewlines(prompt);
  const head = normalized.split(STYLE_BLOCK_SENTINEL)[0] ?? normalized;
  const stripped = head.trimEnd();
  if (!styleId) return stripped;
  const style = getStyle(styleId);
  if (!style) return stripped;
  return `${stripped}${STYLE_BLOCK_SENTINEL}${style.directive}`;
}

/**
 * Detect which style is currently locked into a Design regen prompt. Returns
 * null when no [STYLE LOCK] block is present or the matched directive
 * doesn't correspond to a known style.
 */
export function detectStyleInPrompt(prompt: string): StyleId | null {
  const normalized = normalizeNewlines(prompt);
  const idx = normalized.indexOf(STYLE_BLOCK_SENTINEL);
  if (idx === -1) return null;
  const tail = normalized.slice(idx + STYLE_BLOCK_SENTINEL.length).trim();
  const match = STYLE_OPTIONS.find((s) => tail.startsWith(s.directive));
  return match?.id ?? null;
}
