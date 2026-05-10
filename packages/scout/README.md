# Scout Agent

Scout is the first agent in the Etsy AI pipeline. It runs nightly, iterates over a
hardcoded list of proven print-on-demand niches, fetches the top-scoring Etsy listings
for each niche via the Etsy v3 API, and calls Claude Sonnet to extract a structured
trend brief (keywords, tags, price target, color palette). Each brief is written to the
`trend_briefs` table with `status = 'pending'` so the Design Agent can pick it up.
Duplicate niches within the last 7 days are skipped automatically.

---

## Local setup

**Requires Python 3.12.**

```bash
# From the project root
python3.12 -m venv .venv
source .venv/bin/activate

pip install -r packages/scout/requirements-dev.txt
```

---

## Environment variables

Copy `.env.example` from the project root and fill in the required values:

```bash
cp .env.example .env
```

The variables Scout needs at runtime:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet calls |
| `ETSY_API_KEY` | Etsy OAuth client ID |
| `ETSY_API_SECRET` | Etsy OAuth client secret |
| `ETSY_ACCESS_TOKEN` | OAuth 2.0 bearer token (expires hourly) |
| `ETSY_REFRESH_TOKEN` | Used to refresh the access token automatically |
| `ETSY_SHOP_ID` | Your Etsy shop ID |
| `SUPABASE_URL` | Local: `http://127.0.0.1:54321` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (never anon key) |

All other vars in `.env.example` are required by the shared config but not used by
Scout directly — set them to placeholder values for local runs.

---

## Running locally

Start the local Supabase stack first (Docker must be running):

```bash
supabase start
supabase migration up
```

Then run Scout from the **project root**:

```bash
source .venv/bin/activate
python -m packages.scout.main
```

Scout logs structured JSON to stdout. A successful run looks like:

```json
{"agent": "scout", "action": "trend_brief_created", "niche": "dog mom gifts", "status": "pending", "duration_ms": 1240, "event": "trend_brief_created", "level": "info", "timestamp": "..."}
```

Run it a second time immediately — you should see `dedup_skip` for every niche and 0
new rows inserted.

---

## Testing

**Unit tests** (no external services needed):

```bash
pytest packages/scout/ --ignore=packages/scout/tests/integration
```

**Integration tests** (requires local Supabase running):

```bash
supabase start
INTEGRATION=1 \
  SUPABASE_URL=http://127.0.0.1:54321 \
  SUPABASE_SERVICE_ROLE_KEY=<your-local-secret-key> \
  pytest packages/scout/tests/integration/
```

The local secret key is printed by `supabase start` and `supabase status` under
`Authentication Keys → Secret`.
