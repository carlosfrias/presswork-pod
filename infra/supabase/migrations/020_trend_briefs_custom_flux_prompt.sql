-- Optional user-provided FLUX prompt. When set, the Design agent's
-- prompt_builder.py uses this verbatim instead of calling Claude to craft one
-- from the brief inputs. Still subject to the FLUX_REQUIRED_TERMS validator —
-- prompts missing the required phrases ("print on demand design", "transparent
-- background", "high resolution", "vector-style") will fail the design's
-- validation step and mark the row as 'error'.
--
-- Default NULL preserves the current flow for every existing row and for any
-- future briefs Scout writes.

ALTER TABLE trend_briefs
  ADD COLUMN IF NOT EXISTS custom_flux_prompt TEXT;
