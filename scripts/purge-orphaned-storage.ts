/**
 * Purges orphaned files from the `designs` storage bucket.
 *
 * A file is considered orphaned if its filename does not appear in either
 * design_packages.image_url or design_packages.image_url_unmasked. These
 * accumulate from failed design runs, superseded regen attempts, and edits
 * where the new version replaced the old one in the DB row.
 *
 * Run with: npx tsx scripts/purge-orphaned-storage.ts
 * Dry run:  DRY_RUN=true npx tsx scripts/purge-orphaned-storage.ts
 */

import { createClient } from "@supabase/supabase-js";
import WebSocketImpl from "ws";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = "designs";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: WebSocketImpl as unknown as typeof WebSocket },
});

async function getReferencedFilenames(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("design_packages")
    .select("image_url, image_url_unmasked");

  if (error) throw new Error(`Failed to query design_packages: ${error.message}`);

  const referenced = new Set<string>();
  for (const row of data ?? []) {
    for (const url of [row.image_url, row.image_url_unmasked]) {
      if (url) {
        const filename = url.split("/designs/").pop();
        if (filename) referenced.add(filename);
      }
    }
  }
  return referenced;
}

async function getAllStorageObjects(): Promise<{ name: string; size: number }[]> {
  const { data, error } = await supabase.storage.from(BUCKET).list("", {
    limit: 1000,
  });
  if (error) throw new Error(`Failed to list storage objects: ${error.message}`);
  return (data ?? []).map((obj) => ({
    name: obj.name,
    size: (obj.metadata as any)?.size ?? 0,
  }));
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no deletions)" : "LIVE — will delete"}\n`);

  const [referenced, allObjects] = await Promise.all([
    getReferencedFilenames(),
    getAllStorageObjects(),
  ]);

  const orphaned = allObjects.filter((obj) => !referenced.has(obj.name));
  const orphanedBytes = orphaned.reduce((sum, obj) => sum + obj.size, 0);
  const totalBytes = allObjects.reduce((sum, obj) => sum + obj.size, 0);
  const keptBytes = totalBytes - orphanedBytes;

  console.log(`Storage bucket: ${BUCKET}`);
  console.log(`Total files:    ${allObjects.length} (${formatMB(totalBytes)})`);
  console.log(`Referenced:     ${referenced.size} files kept (${formatMB(keptBytes)})`);
  console.log(`Orphaned:       ${orphaned.length} files (${formatMB(orphanedBytes)})\n`);

  if (orphaned.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  console.log("Orphaned files to delete:");
  for (const obj of orphaned) {
    console.log(`  ${obj.name.padEnd(70)} ${formatMB(obj.size)}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log("DRY RUN — no files deleted. Remove DRY_RUN=true to execute.");
    return;
  }

  // Delete in batches of 20 (storage API limit)
  const BATCH_SIZE = 20;
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < orphaned.length; i += BATCH_SIZE) {
    const batch = orphaned.slice(i, i + BATCH_SIZE).map((obj) => obj.name);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) {
      console.error(`  Batch ${i / BATCH_SIZE + 1} failed: ${error.message}`);
      failed += batch.length;
    } else {
      deleted += batch.length;
      console.log(`  Deleted batch ${i / BATCH_SIZE + 1} (${batch.length} files)`);
    }
  }

  console.log(`\nDone. Deleted: ${deleted}  Failed: ${failed}`);
  console.log(`Freed ~${formatMB(orphanedBytes)} of storage.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
