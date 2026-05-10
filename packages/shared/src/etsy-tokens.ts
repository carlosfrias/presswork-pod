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
  const { error } = await db
    .from("config")
    .upsert({ key: CONFIG_KEY, value: tokens }, { onConflict: "key" });

  if (error) throw new Error(`Failed to save Etsy tokens: ${error.message}`);
}
