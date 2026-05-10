/**
 * One-time bootstrap script: lists (or creates) a readiness-state definition for the shop,
 * then prints the ID to paste into ETSY_READINESS_STATE_ID in your env / Railway config.
 *
 * Usage:
 *   npx ts-node --esm scripts/get_etsy_readiness_state.ts
 *
 * Reads tokens from cloud Supabase via getValidAccessToken (same as the Listing Agent).
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ETSY_API_KEY, and a valid token row.
 */

import { createClient } from "@supabase/supabase-js";
import { getSettings } from "@presswork/shared";

const settings = getSettings();

const db = createClient(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY);

async function etsyGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": settings.ETSY_API_KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Etsy ${res.status}: ${body}`);
  }
  return res.json();
}

async function etsyPost(path: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": settings.ETSY_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Etsy ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  // Load the current access token from Supabase
  const { getValidAccessToken } = await import("@presswork/shared");
  const token = await getValidAccessToken(db as never);

  const shopId = settings.ETSY_SHOP_ID;
  const path = `/application/shops/${shopId}/readiness-state-definitions`;

  console.log(`Fetching readiness-state definitions for shop ${shopId}...`);
  const existing = (await etsyGet(path, token)) as { results?: Array<{ readiness_state_id: number; processing_min: number; processing_max: number }> };

  if (existing.results && existing.results.length > 0) {
    console.log("\nExisting readiness-state definitions:");
    for (const def of existing.results) {
      console.log(
        `  ID ${def.readiness_state_id}: processing ${def.processing_min}–${def.processing_max} business days`
      );
    }
    const first = existing.results[0];
    console.log(`\n✅ Paste this into your env:\n  ETSY_READINESS_STATE_ID=${first!.readiness_state_id}`);
    return;
  }

  console.log("No definitions found. Creating one with 1–3 business day processing time...");
  const created = (await etsyPost(path, token, {
    processing_min: 1,
    processing_max: 3,
  })) as { readiness_state_id: number };

  console.log(`\n✅ Created. Paste this into your env:\n  ETSY_READINESS_STATE_ID=${created.readiness_state_id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
