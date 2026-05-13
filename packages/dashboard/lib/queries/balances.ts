import "server-only";

export interface FalBalance {
  ok: true;
  current_balance_usd: number;
  username: string | null;
}

export interface BalanceError {
  ok: false;
  error: string;
  status?: number;
}

/**
 * Live current credit balance from fal.ai. The endpoint requires an "Admin"
 * API key (prefix `Key `); per the docs this may or may not be the same value
 * as the inference FAL_KEY. If you get a 401, generate an admin key in the fal
 * dashboard and set it as `FAL_ADMIN_KEY` (falls back to `FAL_KEY`).
 *
 * Cached for 60s — this is a soft-realtime number, no need to hit fal on
 * every dashboard render.
 */
export async function getFalBalance(): Promise<FalBalance | BalanceError> {
  const key = process.env.FAL_ADMIN_KEY || process.env.FAL_KEY;
  if (!key) return { ok: false, error: "FAL_KEY (or FAL_ADMIN_KEY) not set" };

  try {
    const res = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${key}` },
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? "fal returned 401 — your FAL_KEY may not have admin scope. Generate an Admin API key in the fal dashboard and set FAL_ADMIN_KEY."
            : `fal ${res.status}: ${body.slice(0, 120)}`,
      };
    }
    const json = (await res.json()) as {
      username?: string;
      credits?: { current_balance?: number; currency?: string };
    };
    return {
      ok: true,
      current_balance_usd: Number(json.credits?.current_balance ?? 0),
      username: json.username ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown fetch error",
    };
  }
}

export interface AnthropicSpend {
  ok: true;
  windowDays: number;
  total_usd: number;
  by_agent: { agent: string; usd: number; calls: number }[];
}

/**
 * Pipeline-side Anthropic spend over the last `days` days, sourced from our
 * own `llm_usage` table. This is more useful than Anthropic's org-wide Cost
 * Report API would be (which would also include Claude Code, the Workbench,
 * and any other personal usage that isn't this pipeline).
 *
 * Spend is estimated at call time from response.usage token counts × model
 * pricing — see `estimateAnthropicCostUsd` in packages/shared/src/llm-usage.ts.
 */
export async function getAnthropicSpend(
  days = 30,
): Promise<AnthropicSpend | BalanceError> {
  const { serviceClient } = await import("@/lib/supabase/server");
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("llm_usage")
      .select("agent, cost_usd")
      .eq("provider", "anthropic")
      .gte("created_at", since);
    if (error) {
      return { ok: false, error: error.message };
    }
    let total = 0;
    const byAgent = new Map<string, { usd: number; calls: number }>();
    for (const r of (data ?? []) as { agent: string; cost_usd: number | null }[]) {
      const c = Number(r.cost_usd ?? 0);
      total += c;
      const slot = byAgent.get(r.agent) ?? { usd: 0, calls: 0 };
      slot.usd += c;
      slot.calls += 1;
      byAgent.set(r.agent, slot);
    }
    return {
      ok: true,
      windowDays: days,
      total_usd: total,
      by_agent: [...byAgent.entries()]
        .map(([agent, v]) => ({ agent, ...v }))
        .sort((a, b) => b.usd - a.usd),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown query error",
    };
  }
}
