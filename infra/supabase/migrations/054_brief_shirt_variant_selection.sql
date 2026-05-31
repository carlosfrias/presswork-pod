-- Operator-selected color/size set per trend brief.
-- These columns survive Design Regen (same semantics as color_palette and
-- image_model — they describe the brief's intent, not a particular run).
-- Design agent resolves shirt_colors + shirt_sizes to Printify variant IDs
-- via printify_variant_catalog at claim time.
ALTER TABLE trend_briefs
  ADD COLUMN shirt_colors TEXT[] NOT NULL DEFAULT ARRAY['White'],
  ADD COLUMN shirt_sizes  TEXT[] NOT NULL DEFAULT ARRAY['S','M','L','XL','2XL'];
