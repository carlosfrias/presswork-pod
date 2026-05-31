-- printify_variant_catalog: durable per-provider variant registry.
-- Populated by the Design/Listing agents from Printify's variants API so
-- that the pipeline can resolve (blueprint, provider, variant_id) →
-- (color, size) without a live Printify round-trip.

CREATE TABLE printify_variant_catalog (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  blueprint_id      INT     NOT NULL,
  print_provider_id INT     NOT NULL,
  variant_id        INT     NOT NULL,
  color             TEXT    NOT NULL,
  size              TEXT    NOT NULL,
  is_available      BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (blueprint_id, print_provider_id, variant_id)
);

CREATE INDEX idx_printify_variant_catalog_lookup
  ON printify_variant_catalog (blueprint_id, print_provider_id, color, size);

CREATE TRIGGER trg_printify_variant_catalog_updated
  BEFORE UPDATE ON printify_variant_catalog
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
