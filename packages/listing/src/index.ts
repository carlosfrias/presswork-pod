import { getDb, getLogger } from "@presswork/shared";
import { claimNextDesignPackage } from "./poller.js";
import { publishOne, resumePublish } from "./publisher.js";

async function fetchTrendBrief(db: ReturnType<typeof getDb>, trendBriefId: string) {
  const { data, error } = await db
    .from("trend_briefs")
    .select("*")
    .eq("id", trendBriefId)
    .single();
  if (error || !data) throw new Error(`trend_brief ${trendBriefId} not found: ${error?.message}`);
  return data;
}

async function fetchPendingPublishListing(db: ReturnType<typeof getDb>) {
  const { data, error } = await db
    .from("listings")
    .select("id")
    .eq("status", "pending_publish")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to query pending_publish listings: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

interface PendingListingWork {
  id: string;
  design_package_id: string;
}

/**
 * Pick up a listings row at status='pending'. These come from:
 *   - Just-claimed designs (the new claim RPC inserts at 'pending')
 *   - Operator-initiated retries (Retry from error / Recreate Printify product /
 *     Regenerate copy actions all set status back to 'pending')
 *   - Transient publishOne failures that left retry_count < MAX_RETRIES
 */
async function fetchPendingListing(
  db: ReturnType<typeof getDb>
): Promise<PendingListingWork | null> {
  const { data, error } = await db
    .from("listings")
    .select("id, design_package_id")
    .eq("status", "pending")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to query pending listings: ${error.message}`);
  const row = data as PendingListingWork | null;
  if (!row?.design_package_id) return null;
  return row;
}

async function fetchDesign(db: ReturnType<typeof getDb>, designId: string) {
  const { data, error } = await db
    .from("design_packages")
    .select("*")
    .eq("id", designId)
    .single();
  if (error || !data)
    throw new Error(`design_package ${designId} not found: ${error?.message}`);
  return data;
}

export async function run(): Promise<void> {
  const log = getLogger("listing");
  const db = getDb();

  while (true) {
    // Phase 1: Resume an approved listing's Etsy publish.
    const approvedId = await fetchPendingPublishListing(db);
    if (approvedId) {
      log.info({ action: "resume_publish", record_id: approvedId, status: "started" });
      await resumePublish(db, approvedId);
      continue;
    }

    // Phase 2: Process a pending listing. Covers operator retries and any
    // residue from prior agent runs that left listings at 'pending'.
    const pending = await fetchPendingListing(db);
    if (pending) {
      const design = await fetchDesign(db, pending.design_package_id);
      const brief = await fetchTrendBrief(db, design.trend_brief_id ?? "");
      try {
        await publishOne(
          db,
          design as Parameters<typeof publishOne>[1],
          brief as Parameters<typeof publishOne>[2],
          pending.id
        );
      } catch (e) {
        // publishOne owns all DB writes for the failure path. Per the
        // pipeline contract, design.status / .error_message are NEVER
        // written by Listing — the listing's failure stays on the listings
        // row. Just log and continue.
        log.error({
          action: "listing_failure",
          record_id: pending.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    // Phase 3: Claim a fresh approved design. The RPC creates a new
    // listings row at 'pending' atomically — Phase 2 will pick it up on
    // the next iteration.
    const claim = await claimNextDesignPackage(db);
    if (!claim) {
      log.info({ action: "no_pending", status: "idle" });
      break;
    }
    log.info({
      action: "claimed_design",
      record_id: claim.listingId,
      design_package_id: claim.design.id,
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
