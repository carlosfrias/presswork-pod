#!/usr/bin/env node
/**
 * One-time reconcile of the local `listings` table against the shop's real
 * live state on Etsy. The Etsy API was off until now, so the table drifted:
 *
 *   Direction A — phantom resets: a DB row claims to be on Etsy
 *     (status active/publishing, is_active, or an etsy_listing_id) but is NOT
 *     actually live → reset to 'needs_review' so the operator re-approves and
 *     the Listing Agent republishes cleanly.
 *
 *   Direction B — adopt matches: a phantom row whose design is the SAME as a
 *     live listing (the owner hand-made it on Etsy) → repoint the existing row
 *     at the real etsy_listing_id, mark active, and mirror the live copy. This
 *     preserves the design_package link and avoids the agent republishing a
 *     duplicate. Matching is by title-token overlap (printed for review).
 *
 *   Direction C — import untracked: a live listing that matches no phantom row →
 *     insert an 'active' row (design_package_id = NULL) so it's tracked. The
 *     agent only touches 'pending' / 'pending_publish' rows, so it never alters
 *     adopted or imported active rows.
 *
 * Default = DRY RUN (prints the plan, writes nothing). Pass --apply to commit.
 *
 * Usage:
 *   npx tsx scripts/reconcile_etsy_listings.ts            # dry run
 *   npx tsx scripts/reconcile_etsy_listings.ts --apply    # commit
 *
 * Runs against cloud Supabase + real Etsy (set ETSY_MOCK_MODE=false and real
 * OAuth creds). With ETSY_MOCK_MODE=true it diffs against canned fixtures.
 */

import { getDb } from "../packages/shared/src/db.js";
import { getSettings } from "../packages/shared/src/config.js";
import { getActiveEtsyListings, type LiveEtsyListing } from "../packages/shared/src/etsy-api.js";

// DB rows in these states (or carrying an etsy id / is_active flag) assert they
// are live on Etsy. If the matching id isn't actually live, they're phantoms.
const CLAIMS_LIVE_STATUSES = new Set(["active", "publishing"]);

interface ListingRow {
  id: string;
  status: string;
  etsy_listing_id: number | null;
  is_active: boolean | null;
  title: string | null;
}

function claimsLive(row: ListingRow): boolean {
  return (
    CLAIMS_LIVE_STATUSES.has(row.status) ||
    row.is_active === true ||
    row.etsy_listing_id != null
  );
}

// Generic merch/marketing words that carry no design identity — stripped before
// scoring so a match is driven by distinctive subject nouns (cat, beaver, boba).
const TITLE_STOPWORDS = new Set([
  "shirt", "shirts", "tee", "tees", "tshirt", "t", "s",
  "funny", "gift", "gifts", "lover", "lovers", "for", "and", "the", "a", "with",
  "your", "you", "retro", "vintage", "style", "pop", "art", "design", "apparel",
  "meme", "cute", "cool", "unisex", "men", "women", "mens", "womens", "graphic",
  "humor", "humour", "novelty", "gag", "cottagecore",
]);

function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
  return new Set(tokens);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// Require this many distinctive shared tokens to call a phantom row and a live
// listing "the same design". 2 reliably pairs cat/loaf, beaver/dam, boba/tea,
// cannabis/marijuana while leaving unrelated niches (frog, octopus) unmatched.
const MATCH_MIN_SCORE = 2;

interface Pair {
  row: ListingRow;
  live: LiveEtsyListing;
  score: number;
}

/**
 * Greedy one-to-one matcher: scores every (phantom row, live listing) pair by
 * title-token overlap, then assigns highest-scoring pairs first so a stronger
 * match wins a contested listing. Returns the accepted pairs.
 */
function matchPairs(phantoms: ListingRow[], live: LiveEtsyListing[]): Pair[] {
  const rowTokens = new Map(phantoms.map((r) => [r.id, titleTokens(r.title ?? "")]));
  const liveTokens = new Map(live.map((l) => [l.etsyListingId, titleTokens(l.title)]));

  const candidates: Pair[] = [];
  for (const row of phantoms) {
    for (const l of live) {
      const score = overlapScore(rowTokens.get(row.id)!, liveTokens.get(l.etsyListingId)!);
      if (score >= MATCH_MIN_SCORE) candidates.push({ row, live: l, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedRows = new Set<string>();
  const usedLive = new Set<number>();
  const accepted: Pair[] = [];
  for (const c of candidates) {
    if (usedRows.has(c.row.id) || usedLive.has(c.live.etsyListingId)) continue;
    usedRows.add(c.row.id);
    usedLive.add(c.live.etsyListingId);
    accepted.push(c);
  }
  return accepted;
}

async function main() {
  const apply = process.argv.includes("--apply");
  getSettings(); // fail-fast on missing env vars
  const db = getDb();

  console.log(`\n── Etsy ↔ listings reconcile (${apply ? "APPLY" : "DRY RUN"}) ──\n`);

  // 1. Live Etsy listings.
  const live = await getActiveEtsyListings(db);
  const liveIds = new Set(live.map((l) => l.etsyListingId));
  console.log(`Live on Etsy: ${live.length} listing(s).`);

  // 2. All local listings rows.
  const { data, error } = await db
    .from("listings")
    .select("id, status, etsy_listing_id, is_active, title");
  if (error) throw new Error(`Failed to load listings: ${error.message}`);
  const rows = (data ?? []) as ListingRow[];
  console.log(`Local listings rows: ${rows.length}.\n`);

  const dbEtsyIds = new Set(
    rows.map((r) => r.etsy_listing_id).filter((id): id is number => id != null)
  );

  // Rows already correctly pointing at a live listing — leave them be.
  const alreadyInSync = rows.filter(
    (r) => r.etsy_listing_id != null && liveIds.has(r.etsy_listing_id)
  );

  // Phantoms: rows that claim to be live but whose id isn't actually live.
  const phantoms = rows.filter(
    (r) => claimsLive(r) && !(r.etsy_listing_id != null && liveIds.has(r.etsy_listing_id))
  );

  // Live listings not yet tracked by a correct in-sync row.
  const untrackedLive = live.filter((l) => !dbEtsyIds.has(l.etsyListingId));

  // Direction B — adopt: pair phantoms to untracked live listings by title.
  const pairs = matchPairs(phantoms, untrackedLive);
  const adoptedRowIds = new Set(pairs.map((p) => p.row.id));
  const adoptedLiveIds = new Set(pairs.map((p) => p.live.etsyListingId));

  // Direction A — reset: phantoms that matched nothing.
  const toReset = phantoms.filter((r) => !adoptedRowIds.has(r.id));

  // Direction C — import: live listings that matched no phantom.
  const toImport = untrackedLive.filter((l) => !adoptedLiveIds.has(l.etsyListingId));

  // ── Report ──
  console.log(`Direction B — adopt (link phantom row → live listing): ${pairs.length}`);
  for (const p of pairs) {
    console.log(`  • row ${p.row.id}  (score ${p.score})`);
    console.log(`      was: "${p.row.title ?? ""}" (phantom id ${p.row.etsy_listing_id ?? "—"})`);
    console.log(`      now: etsy_id=${p.live.etsyListingId}  "${p.live.title}"`);
  }

  console.log(`\nDirection A — reset to needs_review: ${toReset.length}`);
  for (const r of toReset) {
    console.log(`  • ${r.id}  status=${r.status}  etsy_id=${r.etsy_listing_id ?? "—"}  ${r.title ?? ""}`);
  }

  console.log(`\nDirection C — import as active (no phantom match): ${toImport.length}`);
  for (const l of toImport) {
    const price = l.price != null ? `${l.price} ${l.currency ?? ""}`.trim() : "—";
    console.log(`  • etsy_id=${l.etsyListingId}  price=${price}  ${l.title}`);
  }

  console.log(`\nAlready in sync (row already points at a live listing): ${alreadyInSync.length}\n`);

  if (!apply) {
    console.log("Dry run — no changes written. Re-run with --apply to commit.\n");
    return;
  }

  // ── Apply ──
  const nowIso = new Date().toISOString();
  let adoptCount = 0;
  for (const p of pairs) {
    const { error: e } = await db
      .from("listings")
      .update({
        status: "active",
        is_active: true,
        etsy_listing_id: p.live.etsyListingId,
        title: p.live.title,
        description: p.live.description,
        tags: p.live.tags,
        ...(p.live.currency === "USD" ? { price_usd: p.live.price } : {}),
        last_pushed_at: nowIso,
        error_message: null,
        retry_count: 0,
      })
      .eq("id", p.row.id);
    if (e) console.error(`  ✗ adopt ${p.row.id}: ${e.message}`);
    else adoptCount++;
  }

  let resetCount = 0;
  for (const r of toReset) {
    const { error: e } = await db
      .from("listings")
      .update({
        status: "needs_review",
        etsy_listing_id: null,
        is_active: false,
        last_pushed_at: null,
        error_message: null,
        retry_count: 0,
      })
      .eq("id", r.id);
    if (e) console.error(`  ✗ reset ${r.id}: ${e.message}`);
    else resetCount++;
  }

  let importCount = 0;
  for (const l of toImport) {
    const { error: e } = await db.from("listings").upsert(
      {
        design_package_id: null,
        status: "active",
        is_active: true,
        etsy_listing_id: l.etsyListingId,
        title: l.title,
        description: l.description,
        tags: l.tags,
        price_usd: l.currency === "USD" ? l.price : null,
        last_pushed_at: nowIso,
      },
      { onConflict: "etsy_listing_id" }
    );
    if (e) console.error(`  ✗ import etsy_id=${l.etsyListingId}: ${e.message}`);
    else importCount++;
  }

  console.log(`\n✅ Applied: ${adoptCount} adopted, ${resetCount} reset, ${importCount} imported.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
