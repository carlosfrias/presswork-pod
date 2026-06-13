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
// Bound the error-park loop so a pathological run of null-FK rows can't spin
// forever; the count is generous relative to any realistic pending backlog.
const MAX_PENDING_SCAN = 50;

interface PendingListingRow {
  id: string;
  design_package_id: string | null;
}

/**
 * Return the oldest claimable pending listing (one with a non-null
 * design_package_id). A pending row with a null design_package_id has no work
 * to do — it would otherwise sit at the head of the queue forever and starve
 * Phase 2 (H1). Such rows are error-parked with an explanatory message and the
 * scan continues to the next pending row. Bounded by MAX_PENDING_SCAN.
 */
async function fetchPendingListing(
  db: ReturnType<typeof getDb>
): Promise<PendingListingWork | null> {
  const log = getLogger("listing");
  for (let scanned = 0; scanned < MAX_PENDING_SCAN; scanned++) {
    const { data, error } = await db
      .from("listings")
      .select("id, design_package_id")
      .eq("status", "pending")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to query pending listings: ${error.message}`);
    const row = data as PendingListingRow | null;
    if (!row) return null; // queue drained
    if (row.design_package_id) {
      return { id: row.id, design_package_id: row.design_package_id };
    }

    // Null FK → no design to publish. Park at error so it leaves the queue
    // head; on the next iteration the next-oldest pending row surfaces.
    // .select("id") so we can tell a real park from a zero-row no-op: if a
    // concurrent agent moved the row out of 'pending' between our SELECT and
    // this UPDATE, the status guard matches nothing and supabase-js returns
    // { data: [], error: null } — without the select it returns { error: null }
    // unconditionally and the park log fires as a false positive.
    const { data: parked, error: parkError } = await db
      .from("listings")
      .update({
        status: "error",
        error_message:
          "pending listing has no linked design_package_id. Cannot publish. " +
          "Send the design back to review or delete this listing.",
      })
      .eq("id", row.id)
      .eq("status", "pending") // optimistic concurrency guard
      .select("id");
    if (parkError) {
      throw new Error(
        `Failed to error-park null-FK pending listing ${row.id}: ${parkError.message}`
      );
    }
    const parkedRows = (parked as Array<{ id: string }> | null) ?? [];
    if (parkedRows.length === 0) {
      // Concurrent race: another agent moved this row out of 'pending' first.
      // Nothing was parked — not an error. Continue scanning the queue.
      log.warn({
        action: "pending_null_fk_park_noop",
        record_id: row.id,
        status: "pending",
      });
      continue;
    }
    log.error({
      action: "pending_null_fk_parked",
      record_id: row.id,
      status: "error",
    });
  }
  return null;
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
      try {
        await resumePublish(db, approvedId);
      } catch (e) {
        // resumePublish owns all DB writes for the failure path (it sets the
        // listings row back to pending_publish or error). Mirror Phase 2:
        // log and continue so one listing's publish failure can't crash the
        // run and starve every other pending_publish / pending / approved row.
        log.error({
          action: "resume_publish_failure",
          record_id: approvedId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
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
