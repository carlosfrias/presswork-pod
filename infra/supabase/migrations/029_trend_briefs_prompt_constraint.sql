-- Optional operator hint that travels with the brief into the Design agent.
--
-- Distinct from `custom_flux_prompt` (which is a full prompt override that
-- bypasses Claude entirely). `prompt_constraint` is a *style guidance* string
-- that gets folded INTO the user-content JSON sent to Claude when the prompt
-- builder runs — Claude reads it as a high-priority composition / rendering
-- directive alongside niche, style_keywords, etc.
--
-- Example: "render as a flat-color screen print of a frog-like character with
-- a calm dutiful stare, no human expressiveness". Scout's inject form is the
-- primary writer; the field is NULL on Scout's auto-discovered briefs and on
-- any pre-029 row.
ALTER TABLE trend_briefs
  ADD COLUMN prompt_constraint TEXT NULL;
