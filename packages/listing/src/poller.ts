import { type Db, DesignPackageSchema, type DesignPackage } from "@presswork/shared";

export interface ClaimedDesign {
  design: DesignPackage;
  /** ID of the listings row created atomically with the claim. */
  listingId: string;
}

/**
 * Atomically claim the next approved design for listing-side processing.
 *
 * As of migration 046 the claim mechanism is the listings-row INSERT itself
 * (not a status flip on design_packages). The RPC returns the new listings
 * row; we fetch the corresponding design separately and hand the caller both.
 *
 * Pipeline contract: design.status is never touched by Listing. The design
 * stays at 'approved' for its whole lifetime; the listings row carries the
 * publish state and any errors.
 *
 * Returns null when no approved design is available without a listing.
 */
export async function claimNextDesignPackage(db: Db): Promise<ClaimedDesign | null> {
  const { data, error } = await db.rpc("claim_pending_design_package");

  if (error) throw new Error(`claim_pending_design_package RPC failed: ${error.message}`);

  const rows = data as Array<{ id: string; design_package_id: string | null }> | null;
  if (!rows || rows.length === 0) return null;

  const listing = rows[0]!;
  if (!listing.design_package_id) {
    throw new Error(
      `claim_pending_design_package returned listing ${listing.id} with no design_package_id`
    );
  }

  // Fetch the claimed design separately. The claim already locked it in
  // the RPC's CTE; this read just hydrates the columns the publisher needs.
  const { data: designRow, error: designErr } = await db
    .from("design_packages")
    .select("*")
    .eq("id", listing.design_package_id)
    .single();

  if (designErr || !designRow) {
    throw new Error(
      `Listing claim succeeded (listing=${listing.id}) but design ${listing.design_package_id} not found: ${designErr?.message}`
    );
  }

  return {
    design: DesignPackageSchema.parse(designRow),
    listingId: listing.id,
  };
}
