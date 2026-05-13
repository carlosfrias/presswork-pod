-- Atomic Scout dedupe + insert (AUDIT_4 C3).
--
-- Before this migration, Scout's flow was three non-transactional calls:
--   1. SELECT id FROM trend_briefs WHERE niche=? AND created_at > now()-7d
--   2. SELECT niche, style_keywords FROM trend_briefs ... (for semantic check)
--   3. INSERT INTO trend_briefs (...)
--
-- Two concurrent Scout processes (Railway redeploy mid-cron, manual trigger
-- racing the schedule, or operator double-click) would both pass step 1 and
-- both INSERT. CLAUDE.md mandates SELECT ... FOR UPDATE SKIP LOCKED on all
-- polling queries; Scout violated that.
--
-- Fix:
--   1. A partial UNIQUE index as a fast belt — any same-day duplicate fails
--      at the DB layer with 23505.
--   2. An RPC that takes a transaction-scoped advisory lock keyed on the
--      niche hash, re-checks the 7-day window with FOR UPDATE, and inserts
--      atomically. Returns NULL if a recent duplicate exists (caller treats
--      this as "lost the race").
--
-- The Python-side fast-path dedupes (`is_recent_duplicate`,
-- `is_semantic_duplicate`) stay in place — they save Claude tokens and DB
-- writes when there's clearly no race. The RPC is the authoritative guard.

-- 1. Belt index — fast same-day uniqueness check.
--    The expression must be IMMUTABLE for indexing. (created_at AT TIME ZONE
--    'UTC')::date is immutable; date_trunc('day', timestamptz) is only
--    STABLE because it depends on session timezone for tz-aware inputs.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trend_briefs_niche_day
  ON trend_briefs (niche, ((created_at AT TIME ZONE 'UTC')::date));

-- 2. Atomic dedupe + insert RPC.
--    Accepts the full row as JSONB so the call shape matches Python's
--    existing `.insert(row)` dict and optional columns take their schema
--    defaults (image_model, custom_flux_prompt, image_quality,
--    prompt_constraint, etc.).
CREATE OR REPLACE FUNCTION insert_trend_brief_if_no_recent(p_row JSONB)
RETURNS trend_briefs
LANGUAGE plpgsql AS $$
DECLARE
  v_niche TEXT;
  existing_id UUID;
  inserted trend_briefs;
BEGIN
  v_niche := p_row->>'niche';
  IF v_niche IS NULL OR v_niche = '' THEN
    RAISE EXCEPTION 'niche is required';
  END IF;

  -- Transaction-scoped advisory lock serializes concurrent attempts for the
  -- same niche. Released automatically on commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext(v_niche));

  SELECT id INTO existing_id
  FROM trend_briefs
  WHERE niche = v_niche
    AND created_at > now() - interval '7 days'
  FOR UPDATE
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO trend_briefs (
    niche,
    style_keywords,
    top_tags,
    price_target_usd,
    color_palette,
    raw_etsy_data,
    claude_analysis,
    status
  ) VALUES (
    v_niche,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(p_row->'style_keywords')),
      ARRAY[]::TEXT[]
    ),
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(p_row->'top_tags')),
      ARRAY[]::TEXT[]
    ),
    NULLIF(p_row->>'price_target_usd', '')::NUMERIC,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(p_row->'color_palette')),
      ARRAY[]::TEXT[]
    ),
    p_row->'raw_etsy_data',
    p_row->'claude_analysis',
    COALESCE(p_row->>'status', 'needs_review')
  )
  RETURNING * INTO inserted;

  RETURN inserted;
END;
$$;
