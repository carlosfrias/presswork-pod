import { z } from "zod";
import type { Db } from "./db.js";
import { getSettings } from "./config.js";

const TokenRowSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
});

export type EtsyTokens = z.infer<typeof TokenRowSchema>;

const CONFIG_KEY = "etsy_oauth";

export async function getEtsyTokens(db: Db): Promise<EtsyTokens> {
  const { data, error } = await db
    .from("config")
    .select("value")
    .eq("key", CONFIG_KEY)
    .maybeSingle();

  if (error) throw new Error(`Failed to read Etsy tokens: ${error.message}`);

  if (data) {
    return TokenRowSchema.parse(data.value);
  }

  // No row yet — seed from env vars, treat as already expired so the first
  // API call will immediately trigger a refresh.
  const { ETSY_ACCESS_TOKEN, ETSY_REFRESH_TOKEN } = getSettings();
  return {
    accessToken: ETSY_ACCESS_TOKEN,
    refreshToken: ETSY_REFRESH_TOKEN,
    expiresAt: new Date(0).toISOString(),
  };
}

export async function setEtsyTokens(db: Db, tokens: EtsyTokens): Promise<void> {
  // Clear the refresh lease (`refreshingUntil`, stamped by the etsy_refresh_lock
  // RPC on the winning caller) in the SAME write that lands the rotated token.
  // This releases the cross-process lease the instant the new token is durable,
  // so a peer waiting on the lease re-reads a fresh token immediately instead of
  // waiting out the full lease window.
  const value = { ...tokens, refreshingUntil: null };
  const { error } = await db
    .from("config")
    .upsert({ key: CONFIG_KEY, value }, { onConflict: "key" });

  if (error) throw new Error(`Failed to save Etsy tokens: ${error.message}`);
}
