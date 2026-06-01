/**
 * Approximate display hex values for the Gildan 64000 catalog color names that
 * live in `printify_variant_catalog`. These are used ONLY to render swatches in
 * the dashboard color picker — they are not authoritative brand values and are
 * never sent to Printify/Etsy (selection is by color *name*, as before).
 *
 * Keep keys in sync with the distinct `color` values for blueprint 145 /
 * provider 39. Unknown names fall back to a neutral grey via `colorHex`.
 */
const GILDAN_64000_COLOR_HEX: Record<string, string> = {
  "Antique Cherry Red": "#971B2F",
  "Antique Heliconia": "#9E1B5B",
  "Antique Sapphire": "#006A8E",
  Azalea: "#DD74A1",
  Black: "#1B1B1B",
  "Cardinal Red": "#8A1538",
  "Carolina Blue": "#7BA4DB",
  Charcoal: "#66676C",
  "Cherry Red": "#AC2B37",
  "Coral Silk": "#FB637E",
  Cornsilk: "#F0EC74",
  Daisy: "#FED101",
  "Dark Chocolate": "#31261D",
  "Dark Heather": "#47484B",
  "Dark Heather Grey": "#565759",
  "Forest Green": "#213B2A",
  Gold: "#EEAD1A",
  "Graphite Heather": "#707372",
  "Heather Berry": "#8E5572",
  "Heather Cardinal": "#8B2332",
  "Heather Galapagos Blue": "#2D5F6E",
  "Heather Heliconia": "#DB3E79",
  "Heather Indigo": "#4D5680",
  "Heather Irish Green": "#5CAA7F",
  "Heather Maroon": "#672E45",
  "Heather Military Green": "#6F6451",
  "Heather Navy": "#333F48",
  "Heather Orange": "#EC7A40",
  "Heather Purple": "#614B79",
  "Heather Radiant Orchid": "#A4789B",
  "Heather Red": "#BA3B41",
  "Heather Royal": "#4456A6",
  "Heather Sapphire": "#0076A5",
  "Ice Grey": "#D7D9D6",
  "Indigo Blue": "#486393",
  Iris: "#586EB0",
  "Irish Green": "#009E60",
  "Jade Dome": "#00857D",
  "Kelly Green": "#008060",
  Kiwi: "#89A84F",
  "Light Blue": "#B5CEE3",
  "Light Pink": "#F0C2D2",
  Lime: "#A0CE4E",
  Maroon: "#642838",
  "Metro Blue": "#3A4A66",
  "Military Green": "#67643F",
  "Mint Green": "#A3D9B0",
  Natural: "#EDE6D6",
  Navy: "#263147",
  Orange: "#F4633A",
  Paragon: "#4E5481",
  Pistachio: "#B5D199",
  Purple: "#5A2D81",
  Red: "#C8102E",
  Royal: "#224D8F",
  Sage: "#9CAB8E",
  Sand: "#CDC0A1",
  Sapphire: "#0072A8",
  Sky: "#8FCAE7",
  "Sport Grey": "#AEB0B2",
  "Stone Blue": "#708090",
  "Tropical Blue": "#009ACD",
  White: "#FFFFFF",
};

const FALLBACK_HEX = "#9AA0A6";

/** Display hex for a Gildan color name. Unknown names → neutral grey. */
export function colorHex(name: string): string {
  return GILDAN_64000_COLOR_HEX[name] ?? FALLBACK_HEX;
}

/**
 * True when a swatch is light enough that it needs a darker checkmark/ring to
 * stay legible (white, natural, pale pastels). Uses perceived luminance.
 */
export function isLightColor(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  // Rec. 709 relative luminance.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.7;
}
