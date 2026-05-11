Spindl Dashboard — Build Plan
Next.js 14 (App Router) + Supabase real-time + Tailwind + shadcn/ui. Deploy to Vercel at spindl.brac.dev. Mobile-responsive from day one.

Auth
Single-user dashboard. Supabase Auth with email/password — one account (yours). Middleware protects all routes. No public pages except login.

Layout
+--------------------------------------------------+
|  Spindl          [balances bar]    [avatar/logout] |
+--------+-----------------------------------------+
| nav    |  main content                           |
|        |                                         |
| Home   |                                         |
| Scout  |                                         |
| Design |                                         |
| Listings|                                        |
| Orders |                                         |
| Finances|                                        |
| Settings|                                        |
+--------+-----------------------------------------+

Mobile: nav collapses to bottom tab bar (Home, Listings, Orders, Finances, More)

Pages
/ — Home (Command Center)
Four agent status cards in a 2x2 grid:
CardShowsScoutlast run timestamp, briefs generated today, next scheduled run, status (idle/running/error)Designqueue depth (pending briefs), images generated today, current status, last error if anyListingpending review count, published today, total active listings, current statusFulfillmentopen orders, shipped today, errors needing attention, current status
Below the grid: revenue sparkline (last 30 days daily margin) and a real-time activity feed powered by Supabase subscriptions on all four tables.
/scout
Table of trend_briefs: niche, style keywords, price target, status, created_at. Filter by status. Click row opens detail view with raw_etsy_data and claude_analysis JSON formatted. "Run Scout Now" button triggers agent via API route.
/design
Grid of design_packages as image cards. Each card shows niche (joined from trend_brief), status, created_at. Click opens full-size image, FLUX prompt, mockups, variant IDs. "Regenerate" button on bad designs resets status to pending.
/listings (three tabs)
Review Queue: listings where status = 'needs_review'. Card per listing with mockup, title, description, price, tags. Approve/Reject/Edit buttons. Active: all is_active = true listings with Etsy links and revenue. Errors: failed listings with retry button.
/orders
Table: etsy_order_id, listing title (joined), status, sale price, print cost, margin, buyer country, created_at. Status badges: received (yellow), submitted (blue), shipped (green), error (red). Click row for Printify order ID, tracking, error log. Filter by status and date range. Retry button on errors.
/finances
Top row — external service balances fetched server-side: Anthropic credits, fal.ai balance, Printify billing, Etsy balance. Revenue section: totals for week/month/all-time, 90-day margin chart (recharts), best/worst niches. Cost section: API cost breakdown, cost per listing, cost per order.
/settings
Env var status checker (green/red, not values). HUMAN_REVIEW_ENABLED toggle. Agent schedule display. Manual trigger buttons. Danger zone: reset queues, clear errors.

Data Layer
typescript// lib/supabase.ts        → browser client with real-time
// lib/supabase-server.ts → server client with service role key (API routes only)
Real-time subscriptions on all four tables for the activity feed. API routes proxy external service calls so keys never reach the browser:
/api/balances/anthropic   → Anthropic usage API
/api/balances/fal         → fal.ai balance API
/api/balances/printify    → Printify billing API
/api/agents/trigger       → POST { agent } triggers a run
/api/listings/approve     → POST { id } updates status
/api/listings/reject      → POST { id } updates status
/api/orders/retry         → POST { id } resets for retry

Tech Stack
LayerToolFrameworkNext.js 14 (App Router, server components)StylingTailwind CSSComponentsshadcn/uiChartsrechartsDatabaseSupabase (same instance as agents)Real-timeSupabase RealtimeAuthSupabase Auth (email/password, single user)DeployVercel (free tier) → spindl.brac.dev

Build Order

Scaffold Next.js + Tailwind + shadcn/ui
Supabase client setup + auth (login page + middleware)
Layout shell (sidebar nav, mobile bottom tabs, top balance bar)
Home page — agent status cards + activity feed with real-time
Listings page — review queue with approve/reject (highest daily value)
Orders page — table with status tracking
Scout + Design pages — data tables and image grid
Finances page — balance API routes + charts
Settings page — toggles and triggers
Mobile polish pass


Schema Addition
Powers the activity feed and agent status cards. Each agent writes a row on start, updates on finish.
sqlCREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  records_processed INT DEFAULT 0,
  duration_ms INT,
  error_message TEXT,
  metadata JSONB
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent, created_at DESC);
