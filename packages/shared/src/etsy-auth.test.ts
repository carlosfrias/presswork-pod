import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const REFRESH_URL = "https://api.etsy.com/v3/public/oauth/token";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

const FUTURE = new Date(Date.now() + 3600 * 1000).toISOString();
const EXPIRED = new Date(0).toISOString();

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("getValidAccessToken", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("returns cached token when not near expiry", async () => {
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "cached-token",
        refreshToken: "refresh-token",
        expiresAt: FUTURE,
      }),
      setEtsyTokens: vi.fn(),
    }));
    const { getValidAccessToken } = await import("./etsy-auth.js");
    const token = await getValidAccessToken({} as never);
    expect(token).toBe("cached-token");
  });

  it("calls refresh endpoint when token is expired and persists new tokens", async () => {
    const setTokensMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "my-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));

    server.use(
      http.post(REFRESH_URL, async () =>
        HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        })
      )
    );

    const { getValidAccessToken } = await import("./etsy-auth.js");
    const token = await getValidAccessToken({} as never);
    expect(token).toBe("new-access-token");
    expect(setTokensMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessToken: "new-access-token" })
    );
  });

  it("coalesces concurrent refresh requests into a single POST (bug #11)", async () => {
    const setTokensMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "my-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));

    let refreshCalls = 0;
    server.use(
      http.post(REFRESH_URL, async () => {
        refreshCalls++;
        // Small async tick so both callers see the in-flight promise.
        await new Promise((r) => setTimeout(r, 10));
        return HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        });
      })
    );

    const { getValidAccessToken } = await import("./etsy-auth.js");
    const [a, b, c] = await Promise.all([
      getValidAccessToken({} as never),
      getValidAccessToken({} as never),
      getValidAccessToken({} as never),
    ]);

    expect(refreshCalls).toBe(1);
    expect(a).toBe("new-access-token");
    expect(b).toBe("new-access-token");
    expect(c).toBe("new-access-token");
    // setEtsyTokens should also only be called once — only the rotated-token
    // write that the in-flight refresh issued.
    expect(setTokensMock).toHaveBeenCalledTimes(1);
  });

  it("throws EtsyAuthError when refresh endpoint returns generic error", async () => {
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "bad-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: vi.fn(),
    }));

    server.use(
      http.post(REFRESH_URL, () => new HttpResponse("invalid_request", { status: 400 }))
    );

    const { getValidAccessToken, EtsyAuthError } = await import("./etsy-auth.js");
    await expect(getValidAccessToken({} as never)).rejects.toThrow(EtsyAuthError);
  });

  it("fires CRITICAL Slack alert and surfaces actionable error on invalid_grant (audit #49)", async () => {
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "stale-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: vi.fn(),
    }));
    const notifySlackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./notifier.js", () => ({
      notifySlack: notifySlackMock,
      notifyEmail: vi.fn(),
    }));

    server.use(
      http.post(REFRESH_URL, () =>
        HttpResponse.json({ error: "invalid_grant", error_description: "Token expired" }, { status: 400 })
      )
    );

    const { getValidAccessToken, EtsyAuthError } = await import("./etsy-auth.js");
    await expect(getValidAccessToken({} as never)).rejects.toThrow(EtsyAuthError);
    await expect(getValidAccessToken({} as never)).rejects.toThrow(/Manual re-authorization/);
    // Dedup: the second call within the 5-min window should NOT fire another alert.
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0]?.[0]).toMatch(/invalid_grant/);
    expect(notifySlackMock.mock.calls[0]?.[1]).toEqual({ severity: "error" });
  });

  it("retries the token write and fires CRITICAL Slack alert when persistence keeps failing after a successful POST (audit H3)", async () => {
    const setTokensMock = vi.fn().mockRejectedValue(new Error("supabase down"));
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "my-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));
    const notifySlackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./notifier.js", () => ({
      notifySlack: notifySlackMock,
      notifyEmail: vi.fn(),
    }));

    let refreshCalls = 0;
    server.use(
      http.post(REFRESH_URL, () => {
        refreshCalls++;
        return HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        });
      })
    );

    const { getValidAccessToken, EtsyAuthError } = await import("./etsy-auth.js");
    // db without .rpc → cross-process lock falls back to best-effort POST.
    await expect(getValidAccessToken({} as never)).rejects.toThrow(EtsyAuthError);
    // Bounded retry: write attempted TOKEN_WRITE_MAX_ATTEMPTS (3) times.
    expect(setTokensMock).toHaveBeenCalledTimes(3);
    // Only one POST: the rotation happened, but persistence is what failed.
    expect(refreshCalls).toBe(1);
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0]?.[0]).toMatch(/could NOT be persisted/);
    expect(notifySlackMock.mock.calls[0]?.[1]).toEqual({ severity: "error" });
  });

  it("skips the Etsy POST when the cross-process lock re-read shows a fresh token (audit H3 lock-loser)", async () => {
    const setTokensMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./etsy-tokens.js", () => ({
      // Our process saw a near-expiry token and entered the refresh path.
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "our-stale-token",
        refreshToken: "our-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));

    // After acquiring the advisory lock, the RPC re-read reveals a token a
    // peer process already rotated: needs_refresh=false, wait=false.
    const rpcMock = vi.fn().mockResolvedValue({
      data: [
        {
          access_token: "peer-fresh-token",
          refresh_token: "peer-rotated-refresh",
          expires_at: FUTURE,
          needs_refresh: false,
          wait: false,
          has_row: true,
        },
      ],
      error: null,
    });

    let refreshCalls = 0;
    server.use(
      http.post(REFRESH_URL, () => {
        refreshCalls++;
        return HttpResponse.json({
          access_token: "should-not-be-used",
          refresh_token: "should-not-be-used",
          expires_in: 3600,
        });
      })
    );

    const { getValidAccessToken } = await import("./etsy-auth.js");
    const token = await getValidAccessToken({ rpc: rpcMock } as never);

    expect(token).toBe("peer-fresh-token");
    // No Etsy POST: another process already refreshed; a second POST would have
    // bricked the rotated refresh token.
    expect(refreshCalls).toBe(0);
    // We did not write tokens ourselves — the peer already persisted them.
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith("etsy_refresh_lock", {
      p_buffer_seconds: 60,
      p_lease_seconds: 30,
    });
  });

  it("lease loser backs off then returns the peer's freshly-persisted token with ZERO Etsy POSTs (audit H3 lease)", async () => {
    const setTokensMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "our-stale-token",
        refreshToken: "our-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));

    // First RPC call: a peer holds the lease mid-refresh -> wait=true, no token
    // yet. Second call (after our back-off): the peer has persisted, so the
    // re-read returns a fresh token with wait=false.
    const rpcMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            access_token: null,
            refresh_token: null,
            expires_at: null,
            needs_refresh: false,
            wait: true,
            has_row: true,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            access_token: "peer-fresh-token",
            refresh_token: "peer-rotated-refresh",
            expires_at: FUTURE,
            needs_refresh: false,
            wait: false,
            has_row: true,
          },
        ],
        error: null,
      });

    let refreshCalls = 0;
    server.use(
      http.post(REFRESH_URL, () => {
        refreshCalls++;
        return HttpResponse.json({
          access_token: "should-not-be-used",
          refresh_token: "should-not-be-used",
          expires_in: 3600,
        });
      })
    );

    const { getValidAccessToken } = await import("./etsy-auth.js");
    const token = await getValidAccessToken({ rpc: rpcMock } as never);

    expect(token).toBe("peer-fresh-token");
    // We backed off and re-polled the RPC instead of POSTing.
    expect(rpcMock).toHaveBeenCalledTimes(2);
    // Zero Etsy POSTs: the peer rotated the token; a competing POST would brick it.
    expect(refreshCalls).toBe(0);
    // We never persisted — the peer's setEtsyTokens already did.
    expect(setTokensMock).not.toHaveBeenCalled();
  });

  it("throws EtsyAuthError and does NOT persist when Etsy success body has a non-numeric expires_in (zod)", async () => {
    const setTokensMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./etsy-tokens.js", () => ({
      getEtsyTokens: vi.fn().mockResolvedValue({
        accessToken: "old-token",
        refreshToken: "my-refresh",
        expiresAt: EXPIRED,
      }),
      setEtsyTokens: setTokensMock,
    }));

    server.use(
      http.post(REFRESH_URL, () =>
        // Malformed: expires_in is missing. A NaN-epoch token must never be
        // minted — zod must reject and the write must not happen.
        HttpResponse.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
        })
      )
    );

    const { getValidAccessToken, EtsyAuthError } = await import("./etsy-auth.js");
    await expect(getValidAccessToken({} as never)).rejects.toThrow(EtsyAuthError);
    await expect(getValidAccessToken({} as never)).rejects.toThrow(/malformed/i);
    expect(setTokensMock).not.toHaveBeenCalled();
  });
});
