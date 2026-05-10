#!/usr/bin/env node
/**
 * Usage: npx tsx scripts/approve-listing.ts <listing_id>
 *
 * Prints copy + mockup URLs for a listing at 'needs_review', then prompts
 * [y/N]. On approval, flips status to 'pending_publish' so the next agent
 * run picks it up and completes the Etsy publish flow
 */

import { createInterface } from "readline";
import { getDb } from "../packages/shared/src/db.js";
import { getSettings } from "../packages/shared/src/config.js";

async function main() {
  const listingId = process.argv[2];
  if (!listingId) {
    console.error("Usage: npx tsx scripts/approve-listing.ts <listing_id>");
    process.exit(1);
  }

  getSettings(); // fail-fast on missing env vars

  const db = getDb();
  const { data, error } = await db
    .from("listings")
    .select("id, status, title, description, tags, price_usd, design_package_id")
    .eq("id", listingId)
    .single();

  if (error || !data) {
    console.error(`Listing not found: ${listingId}`);
    process.exit(1);
  }

  const listing = data as {
    id: string;
    status: string;
    title: string;
    description: string;
    tags: string[];
    price_usd: number;
    design_package_id: string;
  };

  if (listing.status !== "needs_review") {
    console.error(`Listing ${listingId} is at status '${listing.status}', expected 'needs_review'`);
    process.exit(1);
  }

  // Fetch mockup URLs from the linked design_package
  const { data: pkg } = await db
    .from("design_packages")
    .select("mockup_urls")
    .eq("id", listing.design_package_id)
    .single();

  const mockupUrls: string[] = (pkg as { mockup_urls?: string[] } | null)?.mockup_urls ?? [];

  console.log("\n── LISTING REVIEW ──────────────────────────────────────");
  console.log(`ID:          ${listing.id}`);
  console.log(`Title:       ${listing.title}`);
  console.log(`Price:       $${listing.price_usd}`);
  console.log(`Tags:        ${listing.tags?.join(", ")}`);
  console.log(`\nDescription:\n${listing.description}`);
  if (mockupUrls.length > 0) {
    console.log(`\nMockup URLs:`);
    mockupUrls.forEach((url, i) => console.log(`  [${i + 1}] ${url}`));
  } else {
    console.log("\nMockup URLs: (none)");
  }
  console.log("─────────────────────────────────────────────────────────\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Approve this listing? [y/N] ", async (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Skipped.");
      process.exit(0);
    }

    const { error: updateErr } = await db
      .from("listings")
      .update({ status: "pending_publish" })
      .eq("id", listingId)
      .eq("status", "needs_review"); // guard against concurrent updates

    if (updateErr) {
      console.error(`Failed to approve: ${updateErr.message}`);
      process.exit(1);
    }

    console.log(`Approved. Run 'npm run start --workspace=packages/listing' to publish.`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
