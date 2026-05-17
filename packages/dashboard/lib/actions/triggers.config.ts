import path from "node:path";

/**
 * Spawn-command table for the dashboard's "Run agent" buttons.
 *
 * Lives in a separate module from triggers.ts because triggers.ts uses
 * "use server" — and "use server" modules may only export async functions
 * (Next.js enforces this at build time). Exporting the static COMMANDS map
 * from there crashes the page render with "use server file can only export
 * async functions, found object".
 *
 * Kept import-light (no Supabase, no auth) so triggers.test.ts can introspect
 * the table without needing the full server-action wiring.
 */

export type Agent = "scout" | "design" | "listing" | "ledger";

// Repo root is two levels up from `packages/dashboard` (where `cwd` resolves at runtime).
export const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

// Use the repo's venv interpreter so Python agents run with project deps,
// not whatever `python` happens to resolve to on system PATH (often Python 2.7 on macOS).
export const VENV_PYTHON = path.join(REPO_ROOT, ".venv/bin/python");

export const AGENT_COMMANDS: Record<Agent, { bin: string; args: string[] } | null> = {
  scout: { bin: VENV_PYTHON, args: ["-m", "packages.scout.main"] },
  design: { bin: VENV_PYTHON, args: ["-m", "packages.design.main"] },
  // The listing agent's poller entry point. `start` runs the publisher's
  // index.ts via tsx so we don't have to pre-build the package locally.
  listing: { bin: "npm", args: ["run", "--workspace", "packages/listing", "start"] },
  ledger: { bin: "npm", args: ["run", "--workspace", "packages/ledger", "poll-receipts"] },
};
