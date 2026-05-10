import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getEtsyTokens, setEtsyTokens } from "./etsy-tokens.js";

export class EtsyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyAuthError";
  }
}

const REFRESH_URL = "https://api.etsy.com/v3/public/oauth/token";
const EXPIRY_BUFFER_SEC = 60;

export async function getValidAccessToken(db: Db): Promise<string> {
  const tokens = await getEtsyTokens(db);
  const expiresAt = new Date(tokens.expiresAt).getTime();
  const nowMs = Date.now();

  if (expiresAt - nowMs > EXPIRY_BUFFER_SEC * 1000) {
    return tokens.accessToken;
  }

  const { ETSY_API_KEY } = getSettings();
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
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
