#!/usr/bin/env node
/**
 * Usage: npx tsx --env-file=.env scripts/smoke_listing_printify.ts [design_package_id]
 *
 * Exercises the real packages/listing createHiddenProduct against the cloud
 * Supabase + real Printify API, to verify the two-step upload flow and the
 * per-design print_provider_id wiring work end-to-end.
 *
 * If no design_package_id is given, picks the most recent done row.
 *
 * Cleans up: the created Printify product is deleted at the end so the shop
 * dashboard does not fill up with smoke artifacts.
 */

// Stub the Etsy-only env vars so the strict global getSettings() doesn't reject
// this Printify-only smoke. These vars are validated but never read by the
// Printify code path. Must run before any @presswork/shared import.
process.env.ETSY_SHIPPING_PROFILE_ID = process.env.ETSY_SHIPPING_PROFILE_ID || "1";
process.env.ETSY_PRODUCTION_PARTNER_ID = process.env.ETSY_PRODUCTION_PARTNER_ID || "1";

import { getSettings } from "../packages/shared/src/index.js";
import { createHiddenProduct } from "../packages/listing/src/printify.js";

interface DesignRow {
  id: string;
  image_url: string;
  printify_blueprint_id: number;
  printify_print_provider_id: number | null;
  printify_variant_ids: number[];
}

async function fetchDesign(designId?: string): Promise<DesignRow> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSettings();
  const select = "id,image_url,printify_blueprint_id,printify_print_provider_id,printify_variant_ids";
  const filter = designId
    ? `id=eq.${designId}`
    : "image_url=not.is.null&order=created_at.desc&limit=1";
  const url = `${SUPABASE_URL}/rest/v1/design_packages?select=${select}&${filter}`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`Supabase REST ${r.status}: ${await r.text()}`);
  const rows = (await r.json()) as DesignRow[];
  if (!rows[0]) throw new Error("no design rows");
  return rows[0];
}

async function deleteProduct(productId: string): Promise<void> {
  const { PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID } = getSettings();
  const r = await fetch(
    `https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${PRINTIFY_API_TOKEN}` },
    }
  );
  if (!r.ok) {
    console.warn(`[cleanup] DELETE product ${productId} → ${r.status}: ${await r.text()}`);
  } else {
    console.log(`[cleanup] deleted Printify product ${productId}`);
  }
}

async function main() {
  getSettings();

  const designId = process.argv[2];
  const row = await fetchDesign(designId);

  console.log(`[smoke] using design ${row.id}`);
  console.log(`        image_url=${row.image_url}`);
  console.log(
    `        blueprint=${row.printify_blueprint_id} provider=${row.printify_print_provider_id} variants=${row.printify_variant_ids.length}`
  );

  if (!row.printify_print_provider_id) {
    console.error("design_packages.printify_print_provider_id is null — migration not applied?");
    process.exit(1);
  }

  const t0 = Date.now();
  const { productId, mockupUrls } = await createHiddenProduct({
    imageUrl: row.image_url,
    blueprintId: row.printify_blueprint_id,
    printProviderId: row.printify_print_provider_id,
    variantIds: row.printify_variant_ids,
    title: `Smoke test — ${row.id.slice(0, 8)}`,
  });

  console.log(`[smoke] OK product=${productId} mockups=${mockupUrls.length} in ${Date.now() - t0}ms`);
  for (const url of mockupUrls.slice(0, 3)) console.log(`        ${url}`);

  await deleteProduct(productId);
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
