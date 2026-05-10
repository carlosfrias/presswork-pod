-- Add mockup provenance flag for Etsy image-policy compliance.
--
-- Etsy requires listing images to be of the actual product/design. We use Printify's
-- product-creation side effect to generate mockups from the design's image_url, then
-- upload those mockups to Etsy. This flag records that the mockup_urls in this row
-- were produced from the actual design file (not sourced from generic stock).
--
-- The Listing Agent sets mockups_from_actual_design = true at the same moment it
-- writes mockup_urls back from createHiddenProduct(). The publisher refuses to
-- create the Etsy draft if this flag is not true.
ALTER TABLE design_packages
  ADD COLUMN mockups_from_actual_design BOOLEAN NOT NULL DEFAULT false;
