# Scout Agent — Build Plan

## Context

The Scout Agent is the first link in the 4-agent Etsy/Printify pipeline (see `CLAUDE.md`). It runs nightly on Railway cron, scans Etsy for trending niches via Claude Sonnet analysis, and writes 3–5 `trend_briefs` rows per run with `status='pending'`. The Design Agent picks those up downstream.

Building Scout requires three things to exist first:
- `packages/shared-py/` (config, models, db client, logger)
- Supabase migration `001_trend_briefs.sql` applied to a local Supabase stack
- An `.env` populated from `.env.example`

Per decisions confirmed before planning: include prereqs in this plan, use env-var Etsy tokens with in-memory refresh (defer the Supabase token-store to a later plan), and dedup by exact `niche` string match over the last 7 days.

The plan is broken into 20 small sequential steps. Each step is self-contained and small enough for one focused Sonnet pass.

---

## Phase A — Workspace prerequisites

### Step 1: Root-level config files
Create:
- `.env.example` — every var from CLAUDE.md "Environment Variables" section, with empty values
- `.gitignore` — `.env`, `__pycache__/`, `*.pyc`, `node_modules/`, `.venv/`, `dist/`, `.DS_Store`

### Step 2: `packages/shared-py/` skeleton
Create:
- `packages/shared-py/__init__.py` (empty)
- `packages/shared-py/requirements.txt` — `pydantic>=2.5`, `pydantic-settings>=2.1`, `supabase>=2.3`, `structlog>=24.1`, `anthropic>=0.40`, `httpx>=0.27`

### Step 3: `packages/shared-py/config.py`
A `pydantic-settings` `BaseSettings` class loading every env var from CLAUDE.md. Singleton via `@lru_cache`. Required vars raise on missing; optional vars get defaults (`LOG_LEVEL='info'`, `HUMAN_REVIEW_ENABLED=True`).

### Step 4: `packages/shared-py/logger.py`
`structlog` configured to emit JSON. Helper `get_logger(agent: str)` that binds the `agent` field. Every log line should fit `{ agent, action, record_id, status, duration_ms, error? }` (callers add the rest).

### Step 5: `packages/shared-py/models.py`
Pydantic models mirroring the DB schema:
- `TrendBriefStatus` (Literal: `pending | processing | done | error`)
- `TrendBrief` — fields exactly matching `trend_briefs` columns (id, status, niche, style_keywords, top_tags, price_target_usd, color_palette, raw_etsy_data, claude_analysis, error_message, retry_count, timestamps)
- `TrendBriefCreate` — subset for inserts (no id/timestamps/retry_count)
- `ClaudeAnalysis` — strict shape Claude must return: `niche`, `style_keywords`, `top_tags` (max 13), `price_target_usd`, `color_palette`

### Step 6: `packages/shared-py/db.py`
`get_db() -> Client` returning a Supabase client singleton. Uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from config. Service role only — assert at startup it's not the anon key (anon keys begin with `eyJhbGc...` and have `"role":"anon"` in payload; do a quick decode check).

### Step 7: Migration `infra/supabase/migrations/001_trend_briefs.sql`
Copy the `trend_briefs` table + index + `update_timestamp()` function + trigger verbatim from CLAUDE.md "Database Schema" section. Nothing else — other tables come in their own migrations.

### Step 8: Apply migration locally
- `supabase init` (if not already done)
- `supabase start`
- `supabase db push`
- Verify: `psql ... -c "\d trend_briefs"` shows the table

---

## Phase B — Scout package skeleton

### Step 9: `packages/scout/` skeleton
Create:
- `packages/scout/__init__.py`
- `packages/scout/requirements.txt` — `-r ../shared-py/requirements.txt` plus `tenacity>=8.2` (retries) and `pytest`, `pytest-asyncio`, `respx` as dev deps in a separate `requirements-dev.txt`
- `packages/scout/README.md` — placeholder, will fill in step 19

### Step 10: Niche seed list
`packages/scout/seeds.py` — module-level `NICHE_SEEDS: list[str]` with the proven POD winners suggested in CLAUDE.md: motivational quotes, pet names, occupations. Keep ~10 seeds for v1.

---

## Phase C — Etsy client

### Step 11: `packages/scout/etsy_client.py`
Async `httpx.AsyncClient` wrapper with:
- `asyncio.Semaphore(5)` shared across all calls for the 5 req/sec rule
- Bearer auth from `ETSY_ACCESS_TOKEN`
- Private `_refresh_token()` that POSTs to `https://api.etsy.com/v3/public/oauth/token` with `grant_type=refresh_token`, updates the in-memory access token, returns the new value
- Public `fetch_top_listings(niche: str, limit: int = 25) -> list[dict]` calling `GET /v3/application/listings/active?keywords={niche}&sort_on=score&limit={limit}`
- On 401: call `_refresh_token()` once and retry; if it fails again, raise
- Use `tenacity` for transient 5xx retries (3 attempts, exponential backoff)

### Step 12: `packages/scout/test_etsy_client.py`
Unit tests with `respx`:
- Happy path: returns parsed listing dicts
- Rate limit: 10 concurrent calls don't exceed 5 in-flight (use `asyncio.gather` + assert peak concurrency)
- 401 → refresh → retry path: first call returns 401, refresh endpoint returns new token, retry succeeds
- 401 → refresh → 401 path: raises after one refresh attempt

---

## Phase D — Claude analyzer

### Step 13: `packages/scout/analyzer.py`
- `analyze_niche(raw_listings: list[dict]) -> ClaudeAnalysis`
- Uses the `anthropic` SDK with model `claude-sonnet-4-20250514`
- System prompt: copy verbatim from CLAUDE.md "Agent 1 — Scout" section (the `system = """You are a print-on-demand market analyst..."""` block)
- User message: JSON dump of the relevant fields from `raw_listings` (titles, tags, prices, review counts)
- Parse Claude's response as JSON, then validate against `ClaudeAnalysis` pydantic model
- Use prompt caching (mark the system prompt as `cache_control: ephemeral`) — system prompt is reused across niches in the same run

### Step 14: `packages/scout/test_analyzer.py`
- Mock Anthropic SDK with `pytest-mock`
- Test: valid JSON response parses to `ClaudeAnalysis` correctly
- Test: invalid JSON raises `ValueError` (or pydantic `ValidationError`)
- Test: response with >13 tags is rejected by the pydantic validator
- Test: prompt cache control header is set on the system block

---

## Phase E — Dedup

### Step 15: `packages/scout/dedup.py`
- `async def is_recent_duplicate(niche: str, db: Client) -> bool`
- Query: `trend_briefs.select('id').eq('niche', niche).gte('created_at', now - 7d).limit(1)`
- Returns `True` if any row exists

### Step 16: `packages/scout/tests/integration/test_dedup.py`
- Gated behind `INTEGRATION=1` env var (skip otherwise)
- Setup: insert a trend_brief with `niche='cats'`, `created_at = now()`
- Assert: `is_recent_duplicate('cats', db) is True`
- Assert: `is_recent_duplicate('dogs', db) is False`
- Assert: insert with `created_at = now() - 8 days`, then `is_recent_duplicate('cats', db) is False`
- Cleanup: delete inserted rows in teardown

---

## Phase F — Orchestration

### Step 17: `packages/scout/main.py`
Async entry point:
```python
async def run() -> None:
    log = get_logger("scout")
    db = get_db()
    inserted = 0
    for niche in NICHE_SEEDS:
        if await is_recent_duplicate(niche, db):
            log.info("dedup_skip", niche=niche); continue
        try:
            listings = await etsy.fetch_top_listings(niche)
            analysis = analyze_niche(listings)
            db.table("trend_briefs").insert({
                **analysis.model_dump(),
                "raw_etsy_data": listings,
                "claude_analysis": analysis.model_dump(),
                "status": "pending",
            }).execute()
            inserted += 1
            log.info("trend_brief_created", niche=niche, status="pending")
            if inserted >= 5: break
        except Exception as e:
            log.error("scout_failure", niche=niche, error=str(e))
            # v1: log and continue. Per-row retry logic lives in Design/Listing where rows are polled.

if __name__ == "__main__":
    asyncio.run(run())
```
Every log line includes `agent="scout"`, `action`, `niche`, `status`, `duration_ms` per the logging contract.

### Step 18: `packages/scout/tests/integration/test_main.py`
- Gated by `INTEGRATION=1`
- Mock Etsy via `respx` (return canned listing JSON)
- Mock Anthropic via `pytest-mock` (return a valid `ClaudeAnalysis` JSON)
- Run `await main.run()` against local Supabase
- Assert: 3–5 new rows in `trend_briefs` with `status='pending'`
- Assert: dedup prevents reruns within 7 days (run twice, second run inserts 0)

---

## Phase G — Polish & verification

### Step 19: Fill in `packages/scout/README.md`
Cover:
- What scout does (1 paragraph)
- Local setup: install Python 3.12, `pip install -r requirements.txt -r requirements-dev.txt`
- Required env vars (link to root `.env.example`)
- How to run: `python -m packages.scout.main`
- How to test: `pytest packages/scout` (unit) and `INTEGRATION=1 pytest packages/scout` (integration)

### Step 20: End-to-end manual verification
1. Start local Supabase: `supabase start`
2. Apply migration: `supabase db push`
3. Populate `.env` with real `ANTHROPIC_API_KEY` and `ETSY_*` tokens (or test stubs)
4. Run: `python -m packages.scout.main`
5. Verify: `psql -c "SELECT niche, status, array_length(top_tags, 1) FROM trend_briefs ORDER BY created_at DESC LIMIT 5;"`
6. Expect: 3–5 rows, all `status='pending'`, each with up to 13 tags
7. Run again immediately → expect 0 new rows (dedup working)

---

## Critical files to be created

| Path | Purpose |
|---|---|
| `.env.example` | Env var template |
| `.gitignore` | Exclude secrets, build artifacts |
| `packages/shared-py/config.py` | Env var validation (reused by all Python agents) |
| `packages/shared-py/logger.py` | structlog setup (reused by all Python agents) |
| `packages/shared-py/models.py` | Pydantic models (reused by all Python agents) |
| `packages/shared-py/db.py` | Supabase client singleton |
| `infra/supabase/migrations/001_trend_briefs.sql` | DB schema |
| `packages/scout/etsy_client.py` | Etsy API wrapper with rate limit + token refresh |
| `packages/scout/analyzer.py` | Claude Sonnet trend extraction |
| `packages/scout/dedup.py` | 7-day exact-niche dedup |
| `packages/scout/main.py` | Orchestration entry point |
| `packages/scout/seeds.py` | Hardcoded niche list |
| `packages/scout/README.md` | Setup and run docs |

## Reused references

- All Python agents (scout, design) will share `packages/shared-py/` — design's later build plan should reuse, not duplicate
- The Anthropic system prompt for trend analysis lives verbatim in CLAUDE.md "Agent 1 — Scout" section and should be copied from there in step 13
- The `update_timestamp()` SQL function in step 7 is reused by every future migration (002, 003, 004) — keep it generic

## Verification (end-to-end)

The plan is complete when step 20 succeeds: scout runs against a real local Supabase + real Anthropic API + mocked or real Etsy API, and writes 3–5 `pending` `trend_briefs` rows. Re-running immediately produces 0 new rows. All unit tests pass; integration tests pass under `INTEGRATION=1`.
