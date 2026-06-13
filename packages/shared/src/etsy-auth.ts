import { z } from "zod";
import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getEtsyTokens, setEtsyTokens } from "./etsy-tokens.js";
import { isMockMode } from "./etsy-mock.js";
import { notifySlack } from "./notifier.js";
import { getLogger } from "./logger.js";

export class EtsyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyAuthError";
  }
}

const REFRESH_URL = "https://api.etsy.com/v3/public/oauth/token";
const EXPIRY_BUFFER_SEC = 60;

// Lease window the etsy_refresh_lock RPC stamps on the config row when this
// process wins the refresh. A losing process that sees the lease backs off and
// re-polls rather than launching a competing POST. The lease auto-expires so a
// crashed winner cannot block refresh forever — once it elapses, the next
// caller becomes the new winner.
const REFRESH_LEASE_SEC = 30;
// Loser back-off: poll the RPC again every REFRESH_WAIT_INTERVAL_MS until the
// winner persists (re-read returns a fresh token) or the lease window is spent.
// Total wait is capped below the lease so a crashed winner doesn't strand us:
// when the budget is exhausted we fall through and attempt the refresh ourselves
// (the lease will have expired, so the RPC lets us become the new winner).
const REFRESH_WAIT_INTERVAL_MS = 500;
const REFRESH_WAIT_MAX_ATTEMPTS = Math.floor(
  (REFRESH_LEASE_SEC * 1000) / REFRESH_WAIT_INTERVAL_MS
);

// Lazy logger: getLogger() calls getSettings(), which validates the FULL env.
// Resolving it at module scope would force every importer of the @presswork/shared
// barrel (etsy-auth is re-exported there) to have a complete env at IMPORT time,
// which breaks unit tests that only stub the vars they use. Resolve on first use
// instead — matching how the rest of shared defers env validation into functions.
let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger("etsy-auth");
  return _log;
}

// setEtsyTokens can fail AFTER a successful Etsy POST (transient Supabase
// error). The rotated refresh_token only exists in this process's memory at
// that point — if the write never lands, the grant bricks on the next refresh
// (Etsy already rotated the token we read in). Retry the write a bounded number
// of times before giving up and alerting.
const TOKEN_WRITE_MAX_ATTEMPTS = 3;
const TOKEN_WRITE_RETRY_BASE_MS = 100;

// Shape returned by the etsy_refresh_lock RPC (migration 058). The RPC holds a
// transaction-scoped advisory lock, re-reads the persisted token, and tells us:
//   needs_refresh=true,  wait=false => we won the lease; POST + persist.
//   needs_refresh=false, wait=false => token is fresh (a peer rotated it); use it.
//   needs_refresh=false, wait=true  => a peer holds the lease mid-refresh; back
//                                      off and re-poll, no token to use yet.
const RefreshLockRowSchema = z.object({
  access_token: z.string().nullable(),
  refresh_token: z.string().nullable(),
  expires_at: z.string().nullable(),
  needs_refresh: z.boolean(),
  wait: z.boolean(),
  has_row: z.boolean(),
});

// Etsy's token-endpoint success body. Validated (not cast) so a malformed or
// absent expires_in can never mint a NaN-epoch token — a NaN expiry would make
// every subsequent expiry check treat the token as stale and re-refresh forever.
const EtsyTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().int().positive(),
});

// Etsy's token-endpoint error body. safeParse so an unexpected shape (HTML error
// page, empty body) degrades to substring matching rather than throwing here.
const EtsyTokenErrorSchema = z.object({
  error: z.string(),
});

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

  // Cross-process serialization with a refresh LEASE. The RPC takes a
  // transaction-scoped advisory lock, re-reads the persisted token under it, and
  // routes us to one of three outcomes (see acquireRefreshAuthority). The
  // advisory lock alone is insufficient: it releases when the RPC returns, BEFORE
  // our 1-5s Etsy POST, so a peer could re-read a still-stale row and double
  // refresh. The lease (a refreshingUntil sentinel on the config row) closes that
  // window — the winner holds it across the POST; losers wait for it to clear.
  const authority = await acquireRefreshAuthority(db);
  if (authority.kind === "use-fresh") {
    // A peer already rotated the token (or finished while we backed off). Use its
    // fresh token; do NOT POST — a second POST would invalidate the peer's
    // rotated refresh_token (Etsy rotates on every use) and brick the grant.
    return authority.accessToken;
  }

  // authority.kind === "refresh": we hold the lease (or RPC was unavailable and
  // we fall back to a best-effort POST). Prefer a refresh_token the re-read
  // surfaced over our possibly-stale in-memory one.
  const effectiveRefreshToken = authority.refreshToken ?? refreshToken;

  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: effectiveRefreshToken,
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
      const json: unknown = JSON.parse(body);
      const parsed = EtsyTokenErrorSchema.safeParse(json);
      isInvalidGrant = parsed.success
        ? parsed.data.error === "invalid_grant"
        : body.includes("invalid_grant");
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

  const rawBody: unknown = await res.json();
  const parsed = EtsyTokenResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    // Malformed success body (e.g. missing/non-numeric expires_in). Refuse to
    // mint a token: a NaN expiry would persist a permanently-stale token and
    // trip an endless refresh loop. The rotated refresh_token is already gone on
    // Etsy's side, so this needs the same manual recovery as invalid_grant.
    throw new EtsyAuthError(
      `Etsy token refresh returned a malformed body: ${parsed.error.message}`
    );
  }
  const data = parsed.data;

  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };

  await persistTokensWithRetry(db, newTokens);
  return newTokens.accessToken;
}

// Outcome of contending for the cross-process refresh lease:
//   use-fresh => a peer already rotated the token; return it WITHOUT a POST.
//   refresh   => we hold the lease (or the RPC was unavailable); POST + persist.
type RefreshAuthority =
  | { kind: "use-fresh"; accessToken: string }
  | { kind: "refresh"; refreshToken: string | null };

// Contend for the right to refresh. Calls the etsy_refresh_lock RPC, then:
//   - winner (needs_refresh=true)         -> { kind: "refresh" } (we hold the lease)
//   - already fresh (needs_refresh=false,
//     wait=false, access_token present)    -> { kind: "use-fresh" }
//   - peer mid-refresh (wait=true)         -> back off, re-poll until the peer
//                                             persists (fresh token) or the lease
//                                             budget is spent (then become winner)
//   - RPC unavailable                      -> { kind: "refresh" } best-effort POST
//                                             (in-process coalescing still guards
//                                             against same-process double-POST)
async function acquireRefreshAuthority(db: Db): Promise<RefreshAuthority> {
  for (let attempt = 0; attempt < REFRESH_WAIT_MAX_ATTEMPTS; attempt++) {
    const decision = interpretLock(await callRefreshLock(db));
    if (decision !== "wait") return decision;

    // wait=true: a peer holds an unexpired lease and is mid-refresh. Back off and
    // re-poll; the peer's setEtsyTokens clears the lease and we'll see the fresh
    // token on the next pass.
    await new Promise((r) => setTimeout(r, REFRESH_WAIT_INTERVAL_MS));
  }

  // Final probe after the last back-off sleep. Without this the loop would fall
  // straight through to a POST even though the winner may have persisted DURING
  // that final sleep — we'd then POST an already-rotated refresh_token and hit
  // invalid_grant. Re-check once: if the winner persisted, use its fresh token.
  // If still unresolved (winner crashed, lease now expired), become the new
  // winner with a best-effort POST so a crashed winner can't strand refresh.
  const finalDecision = interpretLock(await callRefreshLock(db));
  if (finalDecision !== "wait") return finalDecision;
  return { kind: "refresh", refreshToken: null };
}

// Interpret one etsy_refresh_lock re-read into an authority decision, or "wait"
// when a peer holds an unexpired lease and we should back off and re-poll.
//   null (RPC unavailable)                  -> best-effort POST (DB hiccup; the
//                                              per-process coalescing still guards)
//   needs_refresh=false, wait=false, token  -> use the peer's freshly rotated token
//   needs_refresh=true                      -> we won the lease; POST + persist
//   wait=true                               -> "wait"
function interpretLock(
  lock: z.infer<typeof RefreshLockRowSchema> | null
): RefreshAuthority | "wait" {
  if (lock === null) {
    return { kind: "refresh", refreshToken: null };
  }
  if (!lock.needs_refresh && !lock.wait && lock.access_token) {
    return { kind: "use-fresh", accessToken: lock.access_token };
  }
  if (lock.needs_refresh) {
    // Prefer the re-read's refresh_token over our in-memory one so we never POST
    // with a token Etsy has already retired.
    return { kind: "refresh", refreshToken: lock.has_row ? lock.refresh_token : null };
  }
  return "wait";
}

// Call the etsy_refresh_lock RPC and parse the re-read row. Returns null on RPC
// failure (and logs a structured warning) so the caller can degrade to a
// best-effort POST rather than blocking refresh entirely on a DB hiccup. Logging
// here makes a transient DB error correlatable with a later invalid_grant.
async function callRefreshLock(
  db: Db
): Promise<z.infer<typeof RefreshLockRowSchema> | null> {
  try {
    const { data, error } = await db.rpc("etsy_refresh_lock", {
      p_buffer_seconds: EXPIRY_BUFFER_SEC,
      p_lease_seconds: REFRESH_LEASE_SEC,
    });
    if (error) {
      log().warn({ action: "etsy_refresh_lock_fallback", error: error.message });
      return null;
    }

    const rows = Array.isArray(data) ? data : data == null ? [] : [data];
    if (rows.length === 0) return null;

    const parsed = RefreshLockRowSchema.safeParse(rows[0]);
    if (!parsed.success) {
      log().warn({
        action: "etsy_refresh_lock_fallback",
        error: parsed.error.message,
      });
      return null;
    }
    return parsed.data;
  } catch (err) {
    log().warn({
      action: "etsy_refresh_lock_fallback",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// The Etsy POST already succeeded and rotated the refresh_token. If we fail to
// persist, the rotated token is lost and the grant bricks on the next refresh.
// Retry the write a bounded number of times; if it still fails, fire a CRITICAL
// alert so the operator can re-authorize before re-throwing.
async function persistTokensWithRetry(
  db: Db,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string }
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TOKEN_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      await setEtsyTokens(db, tokens);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < TOKEN_WRITE_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TOKEN_WRITE_RETRY_BASE_MS * attempt));
      }
    }
  }

  await notifySlack(
    "CRITICAL: Etsy refresh succeeded but the rotated refresh token could NOT be persisted " +
      "after retries. The grant will brick on the next refresh because Etsy has already retired " +
      "the previous refresh token. Manual re-authorization is required: regenerate the OAuth " +
      "refresh token (scripts/get_etsy_tokens.py), update the etsy_oauth config row, and restart " +
      "the service.",
    { severity: "error" }
  );

  throw new EtsyAuthError(
    `Etsy token rotated but persistence failed after ${TOKEN_WRITE_MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
