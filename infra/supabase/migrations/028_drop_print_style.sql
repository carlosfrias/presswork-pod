-- Drop trend_briefs.print_style.
--
-- Previously two values were allowed: 'full_color' (DTG/sublimation) and
-- 'screen_print' (single-ink with an interior-whitespace strip applied after
-- background removal). The screen-print path has been removed:
--   * fal.ai's birefnet/bria v2 background removers handle interior negative
--     space natively, so the in-house _strip_interior_whitespace pass is no
--     longer doing useful work.
--   * If the operator wants a single-ink look, they can say so in the prompt;
--     the print pipeline doesn't need a separate code path for it.
--
-- Collapse any existing screen_print rows to full_color (their downstream
-- design output is fine — only the post-processing routing differs) and drop
-- the column entirely. Reversal: re-add via migration 014.
UPDATE trend_briefs SET print_style = 'full_color' WHERE print_style = 'screen_print';
ALTER TABLE trend_briefs DROP COLUMN print_style;
