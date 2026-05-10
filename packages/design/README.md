# Design Agent

Design is the second agent in the Etsy AI pipeline. It polls `trend_briefs` rows where
`status = 'pending'`, uses Claude Sonnet to translate each brief into a FLUX-safe image
prompt, calls fal.ai FLUX Pro 1.1 to generate a print-ready PNG, processes the image to
300 dpi with a transparent background, uploads it to Supabase Storage, and writes a
`design_packages` row with `status = 'done'` for the Listing Agent to pick up. The
Listing Agent generates Printify mockups when it creates the product (mockups only
exist as a side-effect of product creation in Printify's API).

v1 scope: one design per trend brief, Gildan 64000 t-shirt only, no colorway variants,
manual run only (no Railway cron). See `DESIGN_AGENT_PLAN.md` for scope rationale.

Background removal uses [`rembg`](https://github.com/danielgatis/rembg) (U²-Net). The
first call in a fresh container downloads the ~170MB model weights and takes roughly
30 seconds — subsequent calls reuse the cached model.

---

## Local setup

**Requires Python 3.12.**

```bash
# From the project root
python3.12 -m venv .venv
source .venv/bin/activate

pip install -r packages/design/requirements-dev.txt
```

---

## Environment variables

Copy `.env.example` from the project root and fill in the required values:

```bash
cp .env.example .env
```

Variables Design needs at runtime (must be real for end-to-end runs):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet calls (prompt builder) |
| `FAL_KEY` | fal.ai FLUX Pro image generation |
| `SUPABASE_URL` | Local: `http://127.0.0.1:54321` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (never anon key) |

All other vars in `.env.example` are required by the shared config — set them to
placeholder values for local runs. Design itself does not call Printify; the Listing
Agent owns that integration.

---

## Running locally

Start the local Supabase stack first (Docker must be running):

```bash
supabase start
supabase migration up
```

Then run Design from the **project root**:

```bash
source .venv/bin/activate
python -m packages.design.main
```

Design loops over all pending `trend_briefs` and exits when none remain. Structured JSON
logs go to stdout:

```json
{"agent": "design", "action": "design_package_created", "brief_id": "...", "design_id": "...", "status": "done", "duration_ms": 4200}
```

---

## Testing

**Unit tests** (no external services needed):

```bash
pytest packages/design/ --ignore=packages/design/tests/integration
```

**Integration tests** (requires local Supabase running):

```bash
supabase start
INTEGRATION=1 \
  SUPABASE_URL=http://127.0.0.1:54321 \
  SUPABASE_SERVICE_ROLE_KEY=<your-local-secret-key> \
  pytest packages/design/tests/integration/
```

The local secret key is printed by `supabase start` and `supabase status` under
`Authentication Keys → Secret`.

