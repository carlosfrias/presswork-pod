import { type Db, DesignPackageSchema, type DesignPackage } from "@presswork/shared";

export async function claimNextDesignPackage(db: Db): Promise<DesignPackage | null> {
  const { data, error } = await db.rpc("claim_pending_design_package");

  if (error) throw new Error(`claim_pending_design_package RPC failed: ${error.message}`);

  const rows = data as unknown[];
  if (!rows || rows.length === 0) return null;

  return DesignPackageSchema.parse(rows[0]);
}
