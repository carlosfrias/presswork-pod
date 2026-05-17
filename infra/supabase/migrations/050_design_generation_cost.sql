-- Per-design running cost tally for all fal.ai calls incurred during image
-- generation (image gen + upscaler + bg removal). Incremented by the Design
-- agent on every full regen and every re-mask run.
--
-- Why a column instead of querying llm_usage: llm_usage rows don't carry a
-- design_package_id (adding one would require touching every call site). A
-- maintained column is simpler to query and displays with zero extra joins.
--
-- Default 0: existing rows show $0.00 until their next regen, which is
-- accurate — we don't retroactively impute historical costs.

ALTER TABLE design_packages
  ADD COLUMN generation_cost_usd NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN design_packages.generation_cost_usd IS
  'Running total of fal.ai API costs (image gen + upscaler + bg removal) across all regens and re-masks. Incremented by the Design agent on each write. $0 for local bg removal runs.';
