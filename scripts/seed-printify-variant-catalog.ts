#!/usr/bin/env node
/**
 * Fetches the Printify variant catalog for Gildan 64000
 * (blueprint 145, print_provider 39 — SwiftPOD) and upserts every (color, size)
 * variant into the `printify_variant_catalog` Supabase table.
 *
 * Idempotent / re-runnable: upsert conflicts on (blueprint_id, print_provider_id,
 * variant_id) so running twice is a no-op.
 *
 * After upsert, a provider-agnostic VERIFICATION step guards against a
 * Color/Size axis flip: every derived `size` must be a known apparel size token,
 * no `color` may be a size token, and the staple White + Black colors must be
 * present. A FAIL exits non-zero.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/seed-printify-variant-catalog.ts
 */

import { z } from "zod";
import { printifyFetch } from "../packages/shared/src/printify-http.js";
import { getDb } from "../packages/shared/src/db.js";
import { getSettings } from "../packages/shared/src/config.js";
import { getLogger } from "../packages/shared/src/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const BLUEPRINT_ID = 145; // Gildan 64000 Unisex Softstyle T-Shirt
const PRINT_PROVIDER_ID = 39; // SwiftPOD

// Canonical apparel size tokens (uppercased). Used by the axis-flip guard:
// every derived `size` must be in this set, and no derived `color` may be.
const KNOWN_SIZE_TOKENS = new Set([
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "2XL",
  "3XL",
  "4XL",
  "5XL",
]);

// Staple colors expected from any full-catalog provider for blueprint 145.
const REQUIRED_COLORS = ["White", "Black"];

// ── Zod schemas for the Printify catalog variants response ───────────────────

// Each variant in the catalog has `id`, `title`, and `options` — an object
// whose keys are the option dimension names (e.g. "color", "size") and whose
// values are the human-readable label strings.
// The key names are not contractually fixed (Printify uses lowercase strings),
// so we accept the full options object as a record and derive color/size below.
const CatalogVariantSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  options: z.record(z.string(), z.string()),
  is_available: z.boolean().optional().default(true),
});

const CatalogVariantsResponseSchema = z.object({
  variants: z.array(CatalogVariantSchema),
});

type CatalogVariant = z.infer<typeof CatalogVariantSchema>;

// ── Color / size derivation ───────────────────────────────────────────────────

// Printify uses lowercase dimension keys. Map common spellings → canonical axis.
const COLOR_KEYS = new Set(["color", "colour"]);
const SIZE_KEYS = new Set(["size"]);

/**
 * Extract color and size from a variant's options record.
 *
 * Strategy (in order):
 *  1. Scan option keys for a recognized color key and a recognized size key.
 *  2. Fall back to splitting the title on " / " (Printify convention for
 *     multi-option titles like "White / S" or "Black / 2XL").
 *
 * Returns null for both fields if extraction fails; the caller skips those
 * rows with a warning rather than inserting corrupt data.
 */
function deriveColorAndSize(
  variant: CatalogVariant
): { color: string | null; size: string | null } {
  const entries = Object.entries(variant.options);

  let color: string | null = null;
  let size: string | null = null;

  for (const [key, value] of entries) {
    const keyLower = key.toLowerCase();
    if (COLOR_KEYS.has(keyLower) && color === null) {
      color = value;
    } else if (SIZE_KEYS.has(keyLower) && size === null) {
      size = value;
    }
  }

  // Fall back to title splitting when options[] lacks recognized keys.
  if (color === null || size === null) {
    const parts = variant.title.split("/").map((p) => p.trim());
    // Heuristic: Printify catalog titles are "<Color> / <Size>".
    // We expect exactly 2 parts after splitting; if not, leave as is.
    if (parts.length === 2) {
      if (color === null) color = parts[0] ?? null;
      if (size === null) size = parts[1] ?? null;
    }
  }

  return { color, size };
}

// ── Verification ──────────────────────────────────────────────────────────────

interface VariantRow {
  variant_id: number;
  color: string;
  size: string;
}

function runVerification(upserted: VariantRow[], log: ReturnType<typeof getLogger>): boolean {
  let allPass = true;

  log.info({ action: "verification_start", row_count: upserted.length });

  // 1. Axis-flip guard: a flip would put size tokens (S/M/L/...) in `color`
  //    and color names in `size`. Assert every size is a known token and no
  //    color is a size token.
  const sizesInColorAxis = upserted.filter((r) => KNOWN_SIZE_TOKENS.has(r.size.toUpperCase()) === false);
  if (sizesInColorAxis.length > 0) {
    allPass = false;
    log.error({
      action: "verification_fail",
      check: "unknown_size_token",
      offenders: sizesInColorAxis.slice(0, 10).map((r) => ({ variant_id: r.variant_id, size: r.size })),
      reason: "one or more `size` values are not recognized apparel sizes — possible axis flip or new size",
    });
  }
  const colorsLookingLikeSizes = upserted.filter((r) => KNOWN_SIZE_TOKENS.has(r.color.toUpperCase()));
  if (colorsLookingLikeSizes.length > 0) {
    allPass = false;
    log.error({
      action: "verification_fail",
      check: "color_is_size_token",
      offenders: colorsLookingLikeSizes.slice(0, 10).map((r) => ({ variant_id: r.variant_id, color: r.color })),
      reason: "one or more `color` values are apparel size tokens — Color/Size axis flip",
    });
  }

  // 2. Staple colors present (case-insensitive).
  const presentColors = new Set(upserted.map((r) => r.color.toLowerCase()));
  const missingColors = REQUIRED_COLORS.filter((c) => !presentColors.has(c.toLowerCase()));
  if (missingColors.length > 0) {
    allPass = false;
    log.error({
      action: "verification_fail",
      check: "missing_required_colors",
      missing: missingColors,
    });
  }

  const distinctColors = [...presentColors].length;
  const distinctSizes = new Set(upserted.map((r) => r.size.toUpperCase())).size;

  if (allPass) {
    log.info({
      action: "verification_result",
      status: "PASS",
      distinct_colors: distinctColors,
      distinct_sizes: distinctSizes,
      message: `Catalog resolved cleanly: ${distinctColors} colors x ${distinctSizes} sizes, no axis flip, White + Black present`,
    });
  } else {
    log.error({
      action: "verification_result",
      status: "FAIL",
      message: "Catalog verification failed — see prior verification_fail entries",
    });
  }

  return allPass;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fail fast on missing env vars (validates SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  // PRINTIFY_API_TOKEN, and all other required settings).
  getSettings();
  const log = getLogger("seed-printify-variant-catalog");
  const db = getDb();

  log.info({
    action: "catalog_fetch_start",
    blueprint_id: BLUEPRINT_ID,
    print_provider_id: PRINT_PROVIDER_ID,
  });

  // Fetch from Printify via the shared HTTP client (rate-limited, retried,
  // metrics-tracked). Catalog GETs use the default "global" rate class.
  const raw = await printifyFetch(
    `/catalog/blueprints/${BLUEPRINT_ID}/print_providers/${PRINT_PROVIDER_ID}/variants.json`
  );

  // Validate the response shape with Zod before touching any data.
  const parsed = CatalogVariantsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    log.error({
      action: "catalog_parse_error",
      issues: parsed.error.issues,
    });
    throw new Error(
      `Printify catalog response failed schema validation: ${parsed.error.message}`
    );
  }

  const { variants } = parsed.data;
  log.info({ action: "catalog_fetch_done", variant_count: variants.length });

  // Build rows, skipping any variant where color or size cannot be derived.
  const rows: Array<{
    blueprint_id: number;
    print_provider_id: number;
    variant_id: number;
    color: string;
    size: string;
    is_available: boolean;
  }> = [];

  let skipped = 0;
  for (const variant of variants) {
    const { color, size } = deriveColorAndSize(variant);
    if (color === null || size === null) {
      log.warn({
        action: "variant_skip",
        variant_id: variant.id,
        title: variant.title,
        options: variant.options,
        reason: "could not derive color or size",
      });
      skipped++;
      continue;
    }
    rows.push({
      blueprint_id: BLUEPRINT_ID,
      print_provider_id: PRINT_PROVIDER_ID,
      variant_id: variant.id,
      color,
      size,
      is_available: variant.is_available,
    });
  }

  log.info({
    action: "upsert_start",
    row_count: rows.length,
    skipped_count: skipped,
  });

  // Upsert in a single call; onConflict matches the UNIQUE constraint
  // (blueprint_id, print_provider_id, variant_id) so re-runs are safe.
  const { error: upsertError } = await db
    .from("printify_variant_catalog")
    .upsert(rows, { onConflict: "blueprint_id,print_provider_id,variant_id" });

  if (upsertError) {
    log.error({ action: "upsert_error", message: upsertError.message });
    throw new Error(`Supabase upsert failed: ${upsertError.message}`);
  }

  log.info({ action: "upsert_done", row_count: rows.length });

  // ── Verification ────────────────────────────────────────────────────────────
  // Build a lookup from the rows we just upserted (no DB round-trip needed).
  const upsertedRows: VariantRow[] = rows.map((r) => ({
    variant_id: r.variant_id,
    color: r.color,
    size: r.size,
  }));

  const passed = runVerification(upsertedRows, log);

  if (!passed) {
    process.exit(1);
  }

  log.info({
    action: "seed_complete",
    blueprint_id: BLUEPRINT_ID,
    print_provider_id: PRINT_PROVIDER_ID,
    total_variants: rows.length,
    skipped,
  });
}

main().catch((err) => {
  // Use stderr so structured pino logs don't interleave with the error message.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
