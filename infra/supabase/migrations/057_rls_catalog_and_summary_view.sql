-- Close two public-exposure gaps flagged by the Supabase security advisor.
--
-- Both are holes in the "service-role only" model established by the RLS
-- baseline (migration 031). Every server-side path — the four agents and the
-- dashboard's server queries — uses SUPABASE_SERVICE_ROLE_KEY, which bypasses
-- RLS. So enabling RLS with zero policies is deny-all for anon/authenticated
-- without affecting any real read path.
--
-- 1) printify_variant_catalog (added in migration 053) never had RLS enabled,
--    so anyone holding the public anon key + project URL could read or write
--    all 419 catalog rows. It is only ever read server-side via the service
--    client (packages/dashboard/lib/queries/variants.ts, packages/design/
--    variant_catalog.py). Enable RLS, no policies — same shape as the baseline.
--
-- 2) dashboard_daily_summary was created as a SECURITY DEFINER view (the pre-15
--    default), so an anon PostgREST query against it would run with the owner's
--    privileges and bypass RLS on the underlying orders/llm_usage/listings
--    tables — leaking aggregated revenue and margin. It is only read via the
--    service client (packages/dashboard/lib/queries/overview.ts). Switching to
--    security_invoker makes anon queries subject to the underlying tables' RLS
--    (deny-all); the service role still bypasses it, so the dashboard is
--    unaffected.

ALTER TABLE printify_variant_catalog ENABLE ROW LEVEL SECURITY;
-- No policies → only the service role can read/write.

ALTER VIEW dashboard_daily_summary SET (security_invoker = on);
