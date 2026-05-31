/**
 * One-time lookup: lists the shop's Etsy shipping profiles and prints each
 * shipping_profile_id to paste into ETSY_SHIPPING_PROFILE_ID.
 *
 * Etsy's Shop Manager UI never surfaces the numeric profile ID — only the API
 * does. Shipping profiles are independent of Printify; a "free shipping" profile
 * just means the buyer pays $0 (you still pay Printify its fulfillment shipping).
 *
 * Usage:
 *   npx ts-node --esm scripts/get_etsy_shipping_profiles.ts
 *
 * Reads tokens from cloud Supabase via getValidAccessToken (same as the Listing
 * Agent). Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ETSY_API_KEY,
 * ETSY_API_SECRET, ETSY_SHOP_ID and a valid token row.
 */

import { getSettings, getDb } from "@presswork/shared";

const settings = getSettings();
const db = getDb();

async function etsyGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": `${settings.ETSY_API_KEY}:${settings.ETSY_API_SECRET}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Etsy ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const { getValidAccessToken } = await import("@presswork/shared");
  const token = await getValidAccessToken(db);
  const shopId = settings.ETSY_SHOP_ID;

  console.log(`Fetching shipping profiles for shop ${shopId}...\n`);
  const data = (await etsyGet(
    `/application/shops/${shopId}/shipping-profiles`,
    token
  )) as {
    count?: number;
    results?: Array<{
      shipping_profile_id: number;
      title: string;
      min_processing_days?: number | null;
      max_processing_days?: number | null;
      origin_country_iso?: string;
      profile_type?: string;
    }>;
  };

  const profiles = data.results ?? [];
  if (profiles.length === 0) {
    console.log("No shipping profiles found. Create one in Etsy Shop Manager first.");
    return;
  }

  for (const p of profiles) {
    console.log(
      `shipping_profile_id = ${p.shipping_profile_id}\n` +
        `  title:   ${p.title}\n` +
        `  type:    ${p.profile_type ?? "(n/a)"}\n` +
        `  origin:  ${p.origin_country_iso ?? "(n/a)"}\n` +
        `  process: ${p.min_processing_days ?? "?"}-${p.max_processing_days ?? "?"} days\n`
    );
  }
  console.log(
    `Paste the right shipping_profile_id into ETSY_SHIPPING_PROFILE_ID in your .env.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
