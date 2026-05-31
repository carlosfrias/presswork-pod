-- Per-listing operator variant override.
-- NULL = inherit the design package's full variant set (design_packages.printify_variant_ids).
-- Non-null = operator has narrowed or re-selected variants for this specific listing;
-- must be a subset of design_packages.printify_variant_ids.
ALTER TABLE listings
  ADD COLUMN selected_variant_ids INT[] NULL;
