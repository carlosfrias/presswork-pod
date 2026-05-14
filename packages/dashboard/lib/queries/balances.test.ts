import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

describe("getFalBalance", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = savedEnv;
    vi.unstubAllGlobals();
  });

  it("returns parsed balance on a 200 response", async () => {
    process.env.FAL_KEY = "fal-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          username: "test-user",
          credits: { current_balance: 42.5, currency: "USD" },
        }),
      })),
    );
    vi.resetModules();
    const { getFalBalance } = await import("./balances");

    const result = await getFalBalance();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current_balance_usd).toBe(42.5);
      expect(result.username).toBe("test-user");
    }
  });

  it("returns an error envelope when FAL_KEY is missing", async () => {
    delete process.env.FAL_KEY;
    delete process.env.FAL_ADMIN_KEY;
    vi.resetModules();
    const { getFalBalance } = await import("./balances");

    const result = await getFalBalance();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/FAL_KEY/);
  });

  it("surfaces a 401 from fal with a clear hint", async () => {
    process.env.FAL_KEY = "fal-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      })),
    );
    vi.resetModules();
    const { getFalBalance } = await import("./balances");

    const result = await getFalBalance();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/admin scope|FAL_ADMIN_KEY/);
    }
  });
});

describe("getAnthropicSpend", () => {
  async function loadModule(opts: SupabaseMockOpts) {
    const { client } = makeSupabaseMock(opts);
    vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
    vi.resetModules();
    return await import("./balances");
  }

  it("aggregates Anthropic spend by agent, sorted by usd desc", async () => {
    const usage = [
      { agent: "scout", cost_usd: 0.5 },
      { agent: "scout", cost_usd: 0.5 },
      { agent: "design", cost_usd: 0.1 },
      { agent: "builder", cost_usd: 2 },
    ];
    const { getAnthropicSpend } = await loadModule({ llm_usage: { rows: usage } });

    const result = await getAnthropicSpend(30);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total_usd).toBeCloseTo(3.1, 5);
      expect(result.windowDays).toBe(30);
      expect(result.by_agent[0]).toEqual({ agent: "builder", usd: 2, calls: 1 });
      expect(result.by_agent[1]).toEqual({ agent: "scout", usd: 1, calls: 2 });
    }
  });
});
