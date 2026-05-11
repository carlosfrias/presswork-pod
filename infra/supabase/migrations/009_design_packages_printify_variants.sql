-- design_packages.printify_variants: per-variant option labels captured at
-- product-creation time so Fulfillment can resolve an Etsy receipt's
-- transaction.variations (size/color) back to the correct Printify variant_id
-- instead of always shipping printify_variant_ids[0].
--
-- Shape:
--   [
--     { "id": 38163, "values": ["s", "black"] },
--     { "id": 38177, "values": ["m", "black"] }
--   ]
-- where values is the lowercased set of option labels for that variant.

ALTER TABLE design_packages
  ADD COLUMN IF NOT EXISTS printify_variants JSONB;
