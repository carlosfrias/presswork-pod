-- design_packages.printify_print_provider_id: enforce that any row with a
-- blueprint_id also carries a print_provider_id. Printify variant IDs are
-- scoped to a (blueprint_id, print_provider_id) pair — a NULL provider here
-- causes silent 4xx from POST /shops/{shop}/products.json when the variant
-- IDs don't belong to the (resolved-implicit) provider.
--
-- Migration 008 backfilled provider=3 only WHERE blueprint=145. This adds the
-- forward-looking CHECK so a future row written by Design for a new blueprint
-- without its paired provider fails fast at insert time, instead of producing
-- an orphaned row that Listing later 4xx's on.
--
-- NOT VALID + VALIDATE in two statements:
--   1) ADD CONSTRAINT … NOT VALID    — applies to future writes immediately.
--   2) ALTER … VALIDATE CONSTRAINT … — checks existing rows under a lock that
--      doesn't block reads/writes. Fails loudly if any pre-008 row still has
--      a non-NULL blueprint with NULL provider — that's the right outcome,
--      surface the latent footgun instead of masking it. If it fails, repair
--      the offending row(s) and re-run the VALIDATE.
ALTER TABLE design_packages
  ADD CONSTRAINT design_packages_print_provider_required
  CHECK (
    printify_blueprint_id IS NULL
    OR printify_print_provider_id IS NOT NULL
  )
  NOT VALID;

ALTER TABLE design_packages
  VALIDATE CONSTRAINT design_packages_print_provider_required;
