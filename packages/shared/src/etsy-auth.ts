import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getEtsyTokens, setEtsyTokens } from "./etsy-tokens.js";
import { isMockMode } from "./etsy-mock.js";
import { notifySlack } from "./notifier.js";

export class EtsyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyAuthError";
  }
}

const REFRESH_URL = "https://api.etsy.com/v3/public/oauth/token";
const EXPIRY_BUFFER_SEC = 60;

// Stable mock token surfaced to every Etsy call when ETSY_MOCK_MODE=true.
// Format mirrors a real Etsy access token (prefix + opaque body) so anything
// downstream that pattern-matches the value keeps working.
const MOCK_ACCESS_TOKEN = "mock-access-token-aaaaaaaaaaaaaaaaaaaaaaaa";

// invalid_grant means Etsy considers the refresh token dead — manual
// re-authorization is required (regenerate via OAuth, update env, redeploy).
// Dedup the alert so retry loops don't spam Slack.
const INVALID_GRANT_ALERT_DEDUP_MS = 5 * 60 * 1000;
let _lastInvalidGrantAlertAt = 0;

// Module-scope coalesce: concurrent callers share the same in-flight refresh
// instead of each firing their own POST. Two parallel POSTs would invalidate
// each other's rotated refresh_token (Etsy rotates on every use), forcing a
// full re-auth.
let pendingRefresh: Promise<string> | null = null;

export async function getValidAccessToken(db: Db): Promise<string> {
  // Mock mode: skip the DB read AND the refresh POST entirely. We never want
  // to write rotating mock tokens into the real config table, and we never
  // want a missing tokens row to block a mock-mode dry run.
  if (isMockMode()) {
    return MOCK_ACCESS_TOKEN;
  }

  const tokens = await getEtsyTokens(db);
  const expiresAt = new Date(tokens.expiresAt).getTime();
  const nowMs = Date.now();

  if (expiresAt - nowMs > EXPIRY_BUFFER_SEC * 1000) {
    return tokens.accessToken;
  }

  if (pendingRefresh) {
    return pendingRefresh;
  }

  pendingRefresh = doRefresh(db, tokens.refreshToken).finally(() => {
    pendingRefresh = null;
  });
  return pendingRefresh;
}

async function doRefresh(db: Db, refreshToken: string): Promise<string> {
  const { ETSY_API_KEY } = getSettings();
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();

    // Detect Etsy's invalid_grant — the refresh token is permanently dead
    // (rotated by a parallel refresh, or the user revoked authorization).
    // Surface a CRITICAL Slack alert with manual recovery instructions so the
    // operator notices before downstream calls start failing with generic 401s.
    let isInvalidGrant = false;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      isInvalidGrant = parsed.error === "invalid_grant";
    } catch {
      isInvalidGrant = body.includes("invalid_grant");
    }

    if (isInvalidGrant) {
      const now = Date.now();
      if (now - _lastInvalidGrantAlertAt > INVALID_GRANT_ALERT_DEDUP_MS) {
        _lastInvalidGrantAlertAt = now;
        await notifySlack(
          "Etsy refresh token is dead (invalid_grant). Manual re-authorization required: regenerate the OAuth refresh token, update ETSY_REFRESH_TOKEN, and restart the service.",
          { severity: "error" }
        );
      }
      throw new EtsyAuthError(
        "Etsy refresh token is dead (invalid_grant). Manual re-authorization required: regenerate the OAuth refresh token, update ETSY_REFRESH_TOKEN, and restart the service."
      );
    }

    throw new EtsyAuthError(`Etsy token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };

  await setEtsyTokens(db, newTokens);
  return newTokens.accessToken;
}
