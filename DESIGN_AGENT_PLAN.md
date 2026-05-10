# Design Agent — Build Plan

## Context

The Design Agent is the second link in the 4-agent Etsy/Printify pipeline (see `CLAUDE.md`). It polls `trend_briefs` rows where `status='pending'`, generates one original print-ready PNG per brief via fal.ai (FLUX Pro 1.1), uploads it to Supabase Storage, requests Printify mockups, and writes one `design_packages` row per brief with `status='done'` for the Listing Agent to pick up.

Scout is already built. Shared infrastructure exists at `packages/shared_py/` (config, logger, db client, models) and migration `001_trend_briefs.sql` is applied. Design must reuse all of it — no new config classes, no parallel logger, no duplicate DB client.

Per decisions confirmed before planning:
- **Mockups:** Printify is the v1 provider, but build behind a `MockupProvider` interface so Placeit can be added later without re-plumbing `main.py`.
- **Variants:** v1 produces one design per brief. The schema's `mockup_urls TEXT[]` already supports adding colorway variants later without a migration.
- **Products:** v1 supports only the Gildan 64000 t-shirt (one Printify blueprint, one set of variant IDs). Multi-product expansion is a later plan.
- **Schedule:** v1 runs manually via `python -m packages.design.main`. No Railway cron registration. Cron gets added once FLUX output and per-run cost are validated.

The plan is broken into 22 small sequential steps. Each step is self-contained and small enough for one focused Sonnet pass.

---

## Phase A — Workspace prerequisites

### Step 1: Migration `infra/supabase/migrations/002_design_packages.sql`
Create the migration with:
- The `design_packages` table verbatim from CLAUDE.md "Database Schema" section
- `CREATE INDEX idx_design_packages_status ON design_packages(status);`
- `CREATE TRIGGER trg_design_packages_updated BEFORE UPDATE ON design_packages FOR EACH ROW EXECUTE FUNCTION update_timestamp();` (function already exists from migration 001 — do not redefine)
- A Postgres function `claim_pending_trend_brief()` that atomically claims one row:
  ```sql
  CREATE OR REPLACE FUNCTION claim_pending_trend_brief()
  RETURNS SETOF trend_briefs AS $$
    UPDATE trend_briefs
    SET status = 'processing'
    WHERE id = (
      SELECT id FROM trend_briefs
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  $$ LANGUAGE sql;
  ```
This RPC is the row-locking primitive the Python client will call via `db.rpc('claim_pending_trend_brief')`.

### Step 2: Apply migration locally
- `supabase db push`
- Verify: `psql -c "\d design_packages"` shows the table, and `psql -c "SELECT claim_pending_trend_brief();"` runs without error (returns empty when no rows are pending).

### Step 3: Create `designs` Supabase Storage bucket
- Via Supabase Studio (or CLI): create a public bucket named `designs`
- Verify: `curl -I {SUPABASE_URL}/storage/v1/bucket/designs` returns 200 with service role auth
- Document the bucket name as a constant in step 4 (do NOT hardcode `"designs"` throughout the codebase)

### Step 4: Extend `packages/shared_py/models.py` with design models
Add (do not break existing TrendBrief models):
- `DesignPackageStatus` — Literal `pending | processing | done | error`
- `DesignPackage` — fields exactly matching `design_packages` columns (id, trend_brief_id, status, image_url, mockup_urls, printify_blueprint_id, printify_variant_ids, fal_prompt, metadata, error_message, retry_count, timestamps)
- `DesignPackageCreate` — subset for inserts (no id/timestamps/retry_count, status defaults to `'pending'`)
- `FluxPrompt` — strict shape Claude must return when building the prompt: `prompt: str`, `negative_prompt: str | None`, `style_descriptors: list[str]`. Add a validator rejecting prompts containing artist names from a small disallow-list (start with `["banksy", "disney", "marvel", "nike", "supreme"]` — keep it short and override-able).

---

## Phase B — Design package skeleton

### Step 5: `packages/design/` skeleton
Create:
- `packages/design/__init__.py` (empty)
- `packages/design/requirements.txt` — `-r ../shared_py/requirements.txt` plus `fal-client>=0.5`, `Pillow>=10.2`, `tenacity>=8.2`
- `packages/design/requirements-dev.txt` — `pytest>=8.0`, `pytest-asyncio>=0.23`, `respx>=0.21`, `pytest-mock>=3.12` (mirror scout exactly)
- `packages/design/pyproject.toml` — single key: `[tool.pytest.ini_options]\nasyncio_mode = "auto"` (mirror scout exactly)
- `packages/design/README.md` — placeholder, filled in step 21

### Step 6: `packages/design/constants.py`
Module-level constants for the t-shirt-only v1 scope:
- `STORAGE_BUCKET = "designs"`
- `GILDAN_64000_BLUEPRINT_ID: int` — the Printify blueprint ID for Gildan 64000 (look up from Printify catalog; document the source URL in a one-line comment)
- `GILDAN_64000_VARIANT_IDS: list[int]` — the variant IDs for the standard color/size set we want to list (start with white t-shirt, sizes S/M/L/XL/2XL — five variant IDs)
- `FLUX_MODEL = "fal-ai/flux-pro/v1.1"`
- `FLUX_IMAGE_SIZE = "square_hd"` — 1024×1024
- `OUTPUT_DPI = 300`
- `OUTPUT_DIMENSIONS_PX = (4500, 5400)` — t-shirt print area at 300dpi (15"×18")

---

## Phase C — Polling

### Step 7: `packages/design/poller.py`
- `def claim_next_brief(db: Client) -> TrendBrief | None`
- Calls `db.rpc('claim_pending_trend_brief').execute()`
- Returns the first row parsed into `TrendBrief`, or `None` if no rows
- The RPC handles the `FOR UPDATE SKIP LOCKED` + status flip atomically — Python code never sees a `pending` row twice

### Step 8: `packages/design/tests/integration/test_poller.py`
Gated by `INTEGRATION=1`. Mirror scout's integration test skeleton.
- Setup: insert two `pending` `trend_briefs` rows directly via `create_client`
- Assert: `claim_next_brief(db)` returns one of them, and that row's status in DB is now `'processing'`
- Assert: a second call returns the other row, also flipped to `'processing'`
- Assert: a third call returns `None`
- Concurrency test: spawn 10 threads each calling `claim_next_brief(db)` against 5 pending rows; assert exactly 5 distinct rows are claimed and 5 calls return `None` (no double-claims)
- Teardown: delete the test rows by id

---

## Phase D — Prompt builder

### Step 9: `packages/design/prompt_builder.py`
- `def build_flux_prompt(brief: TrendBrief) -> FluxPrompt`
- Uses the `anthropic` SDK with model `claude-sonnet-4-20250514` (mirror scout's `analyzer.py` patterns: ephemeral `cache_control` on the system block, `max_tokens=1024`, `response.content[0].text → json.loads → pydantic.model_validate`)
- System prompt enforces the FLUX rules from CLAUDE.md "Agent 2 — Design" section:
  - Always include: `print on demand design, transparent background, high resolution, vector-style`
  - Never include: artist names, brand names, living people, copyrighted characters
  - Translate `brief.style_keywords` and `brief.color_palette` into FLUX-safe descriptors
- User message: JSON dump of the relevant TrendBrief fields (niche, style_keywords, color_palette, top_tags)
- Parse Claude's response as JSON, validate against `FluxPrompt` pydantic model — disallow-list validator from step 4 catches obvious IP violations

### Step 10: `packages/design/test_prompt_builder.py`
- Mock Anthropic SDK with `pytest-mock` (mirror scout's `test_analyzer.py`)
- Test: valid JSON response parses to `FluxPrompt` correctly
- Test: response containing a banned artist name raises `ValidationError`
- Test: response missing the required FLUX boilerplate (`transparent background`, etc.) raises `ValidationError` — add this as a separate validator in step 9
- Test: the system prompt is sent with `cache_control: ephemeral`

---

## Phase E — fal.ai client

### Step 11: `packages/design/fal_client.py`
Thin wrapper around the `fal-client` SDK:
- `async def generate_image(prompt: FluxPrompt) -> bytes` — returns the raw PNG bytes
- Uses `fal_client.run_async(FLUX_MODEL, arguments={...})` with the call shape from CLAUDE.md "Agent 2" section
- After fal returns the image URL, downloads the PNG via `httpx.AsyncClient` and returns the bytes
- Use `tenacity` for transient 5xx retries (3 attempts, exponential backoff) — mirror scout's `etsy_client.py` retry pattern
- Reads `FAL_KEY` from `get_settings()` and sets it on the SDK at module init

### Step 12: `packages/design/test_fal_client.py`
- Mock `fal_client.run_async` with `pytest-mock` (it's not HTTP — patch the SDK function directly)
- Mock the image-URL download with `respx`
- Test: happy path returns PNG bytes
- Test: 5xx on the image download is retried up to 3 times then raises
- Test: the call to `run_async` includes `output_format="png"`, `safety_tolerance="2"`, `num_images=1`, `image_size="square_hd"`

---

## Phase F — Image processing

### Step 13: `packages/design/image_processor.py`
- `def process_for_print(png_bytes: bytes) -> bytes`
- Uses Pillow:
  - Open the PNG
  - If it has no alpha channel, force RGBA
  - If it has a near-white background (sample corner pixels), make it transparent (use `PIL.ImageChops` + threshold; document the threshold)
  - Resize to `OUTPUT_DIMENSIONS_PX` from constants, preserving aspect ratio (pad with transparent if needed)
  - Set DPI to 300 via `image.save(..., dpi=(OUTPUT_DPI, OUTPUT_DPI))`
- Returns the processed PNG bytes
- Pure function — no I/O, no logger, no DB. Trivially testable.

### Step 14: `packages/design/test_image_processor.py`
Pure unit tests with synthetic Pillow images (no network, no fal):
- Test: input with white background returns output with alpha=0 in those pixels
- Test: input larger/smaller than target gets resized to exactly `OUTPUT_DIMENSIONS_PX`
- Test: output PNG metadata reports DPI=300 (read it back with `PIL.Image.open(...).info['dpi']`)
- Test: input that's already RGBA with proper transparency passes through without modification

---

## Phase G — Storage

### Step 15: `packages/design/storage.py`
- `def upload_design(db: Client, design_id: UUID, png_bytes: bytes) -> str`
- Uploads to Supabase Storage bucket `designs` at path `{design_id}.png`
- Uses `db.storage.from_(STORAGE_BUCKET).upload(...)` with `file_options={"content-type": "image/png", "upsert": "true"}`
- Returns the public URL via `db.storage.from_(STORAGE_BUCKET).get_public_url(path)`
- Validates the returned URL is non-empty before returning (storage failures are silent on the supabase-py client otherwise)

### Step 16: `packages/design/tests/integration/test_storage.py`
Gated by `INTEGRATION=1`.
- Setup: generate a small valid PNG with Pillow in-memory
- Call `upload_design(db, uuid4(), png_bytes)`
- Assert: returned URL responds with 200 and `Content-Type: image/png` when fetched
- Assert: re-uploading to the same path (upsert) succeeds and returns the same URL
- Teardown: delete the uploaded object

---

## Phase H — Mockup providers

### Step 17: `packages/design/mockup/base.py` + Placeit stub
Define the strategy interface:
```python
class MockupProvider(Protocol):
    async def generate(self, image_url: str, blueprint_id: int, variant_ids: list[int]) -> list[str]:
        """Return a list of mockup image URLs."""
```
Also create `packages/design/mockup/__init__.py` exporting `get_provider() -> MockupProvider` that returns the Printify implementation by default; future Placeit support is a config flag flip, not a code change in `main.py`.

Create `packages/design/mockup/placeit.py` as a stub that raises `NotImplementedError("Placeit provider scheduled for v2 — see DESIGN_AGENT_PLAN.md")`. This keeps the import surface stable and makes the future plan obvious.

### Step 18: `packages/design/mockup/printify.py`
- `class PrintifyMockupProvider(MockupProvider)`
- Async `httpx.AsyncClient` with bearer auth from `PRINTIFY_API_TOKEN`
- `generate(image_url, blueprint_id, variant_ids)`:
  1. POST `https://api.printify.com/v1/uploads/images.json` with the public `image_url` → returns the Printify image_id
  2. POST to the Printify mockup endpoint with the image_id + blueprint_id + variant_ids
  3. Poll the mockup job until it returns URLs (Printify mockup generation is async; document the polling cadence — 2s intervals, 60s max)
  4. Return the list of mockup URLs
- Use `tenacity` for transient 5xx retries
- Honor Printify rate limits (the API caps at 600 req/min per token — well above what this agent needs, but log a warning if a 429 is ever returned)

### Step 19: `packages/design/mockup/test_printify.py`
Unit tests with `respx`:
- Happy path: upload → mockup request → poll-until-ready → return URLs
- 429 from upload: tenacity retries, eventually succeeds
- Mockup job that never completes (always returns "pending"): raises `TimeoutError` after 60s (use a short test override of the polling cap)
- Image upload failure (4xx): raises with the Printify error message in the exception text (no retry on 4xx)

---

## Phase I — Orchestration

### Step 20: `packages/design/main.py`
Async entry point, mirroring scout's structure:
```python
async def run() -> None:
    log = get_logger("design")
    db = get_db()
    while True:
        brief = claim_next_brief(db)
        if brief is None:
            log.info("no_pending_briefs"); break
        try:
            flux_prompt = build_flux_prompt(brief)
            png_bytes = await generate_image(flux_prompt)
            processed = process_for_print(png_bytes)
            design_id = uuid4()
            image_url = upload_design(db, design_id, processed)
            mockups = await get_provider().generate(image_url, GILDAN_64000_BLUEPRINT_ID, GILDAN_64000_VARIANT_IDS)
            db.table("design_packages").insert({
                "id": str(design_id),
                "trend_brief_id": str(brief.id),
                "image_url": image_url,
                "mockup_urls": mockups,
                "printify_blueprint_id": GILDAN_64000_BLUEPRINT_ID,
                "printify_variant_ids": GILDAN_64000_VARIANT_IDS,
                "fal_prompt": flux_prompt.prompt,
                "metadata": {"style_descriptors": flux_prompt.style_descriptors},
                "status": "done",
            }).execute()
            db.table("trend_briefs").update({"status": "done"}).eq("id", str(brief.id)).execute()
            log.info("design_package_created", brief_id=str(brief.id), design_id=str(design_id))
        except Exception as e:
            db.table("trend_briefs").update({
                "status": "error",
                "error_message": str(e),
                "retry_count": brief.retry_count + 1,
            }).eq("id", str(brief.id)).execute()
            # If retry_count < 3, flip back to 'pending' so the next run picks it up
            if brief.retry_count + 1 < 3:
                db.table("trend_briefs").update({"status": "pending"}).eq("id", str(brief.id)).execute()
            log.error("design_failure", brief_id=str(brief.id), error=str(e))

if __name__ == "__main__":
    asyncio.run(run())
```
Every log line includes `agent="design"`, `action`, `brief_id`, `design_id?`, `status`, `duration_ms` per the logging contract. The retry_count handling enforces CLAUDE.md's "Error Handling & Retries" section.

### Step 21: `packages/design/tests/integration/test_main.py`
Gated by `INTEGRATION=1`.
- Mock `fal_client.run_async` (returns a small canned PNG URL served by `respx`)
- Mock Anthropic via `pytest-mock` (returns a valid `FluxPrompt` JSON)
- Mock the Printify mockup endpoints with `respx`
- Setup: insert one `pending` trend_briefs row
- Run: `await main.run()`
- Assert: one new `design_packages` row with `status='done'` and a non-empty `image_url`
- Assert: the source `trend_briefs` row is now `status='done'`
- Assert: the file at `image_url` is reachable (HEAD request returns 200)
- Failure-path test: configure the Anthropic mock to raise; assert the trend_briefs row status flips to `pending` with `retry_count=1` (retryable) and to `error` with `retry_count=3` after three failed runs
- Teardown: delete inserted rows + uploaded storage object

---

## Phase J — Polish & verification

### Step 22: Fill in `packages/design/README.md`
Mirror scout's README structure. Cover:
- What design does (1 paragraph)
- Local setup: install Python 3.12, `pip install -r requirements.txt -r requirements-dev.txt`
- Required env vars (link to root `.env.example`; flag that `FAL_KEY`, `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID` must be real for end-to-end runs)
- How to run: `python -m packages.design.main`
- How to test: `pytest packages/design` (unit) and `INTEGRATION=1 pytest packages/design` (integration)
- v1 scope notes: t-shirts only, no colorway variants, manual run only — link to this plan file for the rationale

### Step 23: End-to-end manual verification
1. Ensure local Supabase is running and `001` + `002` migrations are applied; the `designs` bucket exists.
2. Insert a hand-crafted `trend_briefs` row with realistic style_keywords (e.g., a niche from `packages/scout/seeds.py`) and `status='pending'`.
3. Populate `.env` with real `ANTHROPIC_API_KEY`, `FAL_KEY`, `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`.
4. Run: `python -m packages.design.main`
5. Verify in psql: `SELECT id, status, image_url, array_length(mockup_urls, 1) FROM design_packages ORDER BY created_at DESC LIMIT 1;` — expect one row, `status='done'`, non-null `image_url`, mockup count ≥ 1.
6. Open `image_url` in a browser → confirm the PNG looks like a printable design (transparent background, no obvious IP violations, on-niche).
7. Confirm the source `trend_briefs.status = 'done'`.
8. Cost check: confirm fal.ai dashboard shows ~$0.05 spent for the run; Printify dashboard shows the mockup uploads.

---

## Critical files to be created

| Path | Purpose |
|---|---|
| `infra/supabase/migrations/002_design_packages.sql` | DB schema + `claim_pending_trend_brief()` RPC |
| `packages/shared_py/models.py` | (extended) DesignPackage, DesignPackageCreate, FluxPrompt |
| `packages/design/constants.py` | Blueprint/variant IDs, image dimensions, model/bucket names |
| `packages/design/poller.py` | `FOR UPDATE SKIP LOCKED` row claim via RPC |
| `packages/design/prompt_builder.py` | Claude Sonnet → FLUX prompt with IP guardrails |
| `packages/design/fal_client.py` | fal.ai FLUX Pro 1.1 wrapper + image download |
| `packages/design/image_processor.py` | Pillow: 300dpi transparent-bg PNG |
| `packages/design/storage.py` | Supabase Storage upload to `designs/` bucket |
| `packages/design/mockup/base.py` | `MockupProvider` Protocol |
| `packages/design/mockup/printify.py` | Printify Mockup API implementation |
| `packages/design/mockup/placeit.py` | Stub for future Placeit provider |
| `packages/design/main.py` | Orchestration entry point |
| `packages/design/README.md` | Setup and run docs |

## Reused references

- `packages/shared_py/{config,db,logger,models}.py` are reused as-is — no parallel modules
- The Anthropic call shape (system block with `cache_control: ephemeral`, `max_tokens=1024`, JSON-only response, pydantic validation) is copied from `packages/scout/analyzer.py`
- The tenacity retry pattern is copied from `packages/scout/etsy_client.py`
- The integration-test skeleton (gating, fixtures, teardown via `create_client`) is copied from `packages/scout/tests/integration/`
- The `update_timestamp()` SQL function from migration `001` is reused — do NOT redefine it in `002`

## Verification (end-to-end)

The plan is complete when step 23 succeeds: design runs against a real local Supabase + real Anthropic + real fal.ai + real Printify Mockup APIs, picks up one hand-inserted `pending` trend_brief, and writes one `done` `design_packages` row with a reachable `image_url` and at least one mockup URL. All unit tests pass; integration tests pass under `INTEGRATION=1`. The source trend_brief flips to `done`. Failure-path retry behavior is verified by the failure-path integration test in step 21.
