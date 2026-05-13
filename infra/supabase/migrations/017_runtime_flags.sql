-- Runtime flag storage so the dashboard can toggle agent behavior without a
-- redeploy. Agents fall back to their env-var defaults when the table is empty
-- or unreachable (see packages/shared/src/runtime-flags.ts and the Python
-- equivalent), so this migration is fully backward compatible — applying it
-- does not change any agent behavior on its own.

CREATE TABLE runtime_flags (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TRIGGER trg_runtime_flags_updated
  BEFORE UPDATE ON runtime_flags
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Seed with the flags currently controlled by env vars. Values mirror the
-- defaults in packages/shared/src/config.ts and packages/shared_py/config.py.
-- Keys use snake_case to match the existing config field names.
INSERT INTO runtime_flags (key, value, description) VALUES
  ('human_review_enabled',          'true',        'Pause listings at needs_review before publishing to Etsy.'),
  ('scout_vision_enabled',          'false',       'Send Etsy listing thumbnails to Claude in Scout (3-5x token cost).'),
  ('upscaler_enabled',              'true',        'Run fal aura-sr 4x upscale before background removal.'),
  ('birefnet_enabled',              'true',        'Use birefnet for background removal; falls back to rembg when false or on error.'),
  ('background_removal_mode',       '"birefnet"',  'Background removal backend: "birefnet" or "rembg".'),
  ('margin_warning_threshold_usd',  '5.0',         'Per-order Slack warning threshold for margin_usd.')
ON CONFLICT (key) DO NOTHING;
