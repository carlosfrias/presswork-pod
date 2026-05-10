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

export async function run(): Promise<void> {
  const log = getLogger("listing");
  const db = getDb();

  while (true) {
    // Check for listings awaiting resume after human approval
    const approvedId = await fetchPendingPublishListing(db);
    if (approvedId) {
      log.info({ action: "resume_publish", record_id: approvedId, status: "started" });
      await resumePublish(db, approvedId);
      continue;
    }

    // Claim a fresh design_package at 'done'
    const design = await claimNextDesignPackage(db);
    if (!design) {
      log.info({ action: "no_pending", status: "idle" });
      break;
    }

    const brief = await fetchTrendBrief(db, design.trend_brief_id ?? "");
    try {
      await publishOne(db, design, brief as Parameters<typeof publishOne>[2]);
    } catch (e) {
      log.error({ action: "listing_failure", record_id: design.id, error: String(e) });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
