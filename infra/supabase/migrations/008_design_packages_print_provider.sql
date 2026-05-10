-- Add print_provider_id to design_packages.
--
-- Printify variant IDs are scoped to a (blueprint_id, print_provider_id) pair.
-- The Listing Agent must POST that exact pair to /v1/shops/{shop}/products.json
-- when creating the hidden product, otherwise Printify returns 4xx ("variants
-- do not belong to this print provider"). Previously the listing code hardcoded
-- print_provider_id=1, which is invalid for blueprint 145 (Gildan 64000) — this
-- migration moves the value onto each design row so different blueprints can
-- use their correct provider.
--
-- Backfill: every existing row uses blueprint 145 with Marco Fine Arts variants
-- (38163/38177/38191/38205/38219), so they all map to print_provider_id=3.
ALTER TABLE design_packages
  ADD COLUMN printify_print_provider_id INT;

UPDATE design_packages
  SET printify_print_provider_id = 3
  WHERE printify_print_provider_id IS NULL
    AND printify_blueprint_id = 145;
