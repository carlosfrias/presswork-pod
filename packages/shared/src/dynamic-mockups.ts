import retry from "async-retry";
import { z } from "zod";
import { getSettings } from "./config.js";
import { getLogger } from "./logger.js";

/**
 * Thin client for the Dynamic Mockups render API.
 * Docs: https://docs.dynamicmockups.com
 *
 * Auth: x-api-key header carrying the literal "client_id:secret_key" string
 * the dashboard issues. We pass it verbatim — no parsing, no signing.
 *
 * One endpoint covered for now: POST /api/v1/renders. Sync — returns the
 * rendered image URL in `data.export_path`. Asset is referenced by URL, so
 * we feed it our Supabase Storage public URLs directly without uploading.
 *
 * This sits alongside the Printify and Etsy clients in @presswork/shared
 * but uses its own retry pipeline (no Bottleneck — Dynamic Mockups doesn't
 * publish a per-second cap that would benefit from one).
 */

export class DynamicMockupsApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "DynamicMockupsApiError";
  }
}

const RENDERS_URL = "https://app.dynamicmockups.com/api/v1/renders";

const RenderResponseSchema = z.object({
  data: z.object({
    export_label: z.string().nullable().optional(),
    export_path: z.string().url(),
  }),
  success: z.boolean().optional(),
  message: z.string().nullable().optional(),
});

export type RenderResponse = z.infer<typeof RenderResponseSchema>;

export interface RenderMockupArgs {
  /** UUID of the mockup template (from the operator's Dynamic Mockups Library). */
  mockupUuid: string;
  /** UUID of the smart object (placement slot) inside the template. */
  smartObjectUuid: string;
  /** Public URL of the design PNG to composite into the smart object. */
  designUrl: string;
  /**
   * Optional garment color, as a hex string ("#1B1B1B") or CSS color name.
   * Dynamic Mockups "paints the whole smart object" with this value, so it
   * must target the GARMENT smart object — pass `colorSmartObjectUuid` for the
   * shirt body. When `colorSmartObjectUuid` is omitted the color is applied to
   * `smartObjectUuid` (only correct when that slot itself is the colorable
   * garment).
   */
  color?: string;
  /** Smart object the `color` is painted onto (the garment body). */
  colorSmartObjectUuid?: string;
  /** Optional rendering controls. */
  options?: {
    imageFormat?: "jpg" | "png" | "webp";
    imageSize?: number;
    label?: string;
  };
}

/**
 * Render a single mockup. Returns the public URL of the rendered image
 * (lives on Dynamic Mockups' CDN — Etsy can stream it directly during
 * upload, same as we do for Printify mockups today).
 *
 * Throws DynamicMockupsApiError on any non-2xx or schema mismatch. The
 * caller (dashboard server action) is expected to surface the message
 * back to the operator and persist it on listings.error_message.
 */
export async function renderMockup(args: RenderMockupArgs): Promise<string> {
  const { DYNAMIC_MOCKUPS_API_KEY } = getSettings();
  if (!DYNAMIC_MOCKUPS_API_KEY) {
    throw new DynamicMockupsApiError(
      "DYNAMIC_MOCKUPS_API_KEY is not configured. Set it in .env to enable Dynamic Mockups."
    );
  }

  const log = getLogger("dynamic-mockups");

  // The design always composites into smartObjectUuid. A garment color, when
  // requested, is painted onto a SEPARATE smart object (the shirt body) so the
  // design itself isn't tinted. If no dedicated garment slot is given, the
  // color falls back onto the design slot — only correct when that slot is the
  // colorable garment.
  const designSmartObject: Record<string, unknown> = {
    uuid: args.smartObjectUuid,
    asset: { url: args.designUrl },
  };
  const smartObjects: Record<string, unknown>[] = [designSmartObject];
  if (args.color) {
    if (
      args.colorSmartObjectUuid &&
      args.colorSmartObjectUuid !== args.smartObjectUuid
    ) {
      smartObjects.push({ uuid: args.colorSmartObjectUuid, color: args.color });
    } else {
      designSmartObject.color = args.color;
    }
  }

  const body = {
    mockup_uuid: args.mockupUuid,
    smart_objects: smartObjects,
    ...(args.options?.label ? { export_label: args.options.label } : {}),
    ...(args.options?.imageFormat || args.options?.imageSize
      ? {
          export_options: {
            ...(args.options.imageFormat
              ? { image_format: args.options.imageFormat }
              : {}),
            ...(args.options.imageSize ? { image_size: args.options.imageSize } : {}),
          },
        }
      : {}),
  };

  const t0 = Date.now();

  const data = await retry(
    async (bail) => {
      const res = await fetch(RENDERS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": DYNAMIC_MOCKUPS_API_KEY,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const respBody = await res.text();
        // 4xx errors (bad template UUID, malformed body, bad auth) won't
        // get better with retries. Bail to surface the underlying message.
        if (res.status < 500 && res.status !== 429) {
          bail(
            new DynamicMockupsApiError(
              `Dynamic Mockups ${res.status}: ${respBody}`,
              res.status
            )
          );
          return; // unreachable; bail throws synchronously
        }
        throw new DynamicMockupsApiError(
          `Dynamic Mockups ${res.status}: ${respBody}`,
          res.status
        );
      }

      const json = await res.json();
      return RenderResponseSchema.parse(json);
    },
    { retries: 2, factor: 2, minTimeout: 500 }
  );

  if (!data) {
    throw new DynamicMockupsApiError("Dynamic Mockups returned no body");
  }

  log.info({
    action: "render",
    mockup_uuid: args.mockupUuid,
    smart_object_uuid: args.smartObjectUuid,
    color: args.color ?? null,
    duration_ms: Date.now() - t0,
  });

  return data.data.export_path;
}

// ── Per-blueprint template registry ────────────────────────────────────────────
//
// The dashboard's "Generate Dynamic Mockups" button looks up this map to
// find which template + smart-object UUIDs to send to the renders API for
// a given Printify blueprint id.
//
// Operator workflow to enable a new blueprint:
//   1. Pick (or build) a mockup in the Dynamic Mockups Library that matches
//      the blueprint (e.g. unisex tee).
//   2. Note the mockup_uuid (template) and the smart_object.uuid for the
//      print area you want the design composited into.
//   3. Add an entry here keyed by the Printify blueprint id.
//
// Empty by default — the integration ships wired up but inactive until at
// least one blueprint has a template configured. The dashboard button is
// disabled with helper text when there's no entry.

export interface DynamicMockupsTemplate {
  mockupUuid: string;
  smartObjectUuid: string;
  /**
   * Optional UUID of the smart object representing the GARMENT body (the shirt),
   * distinct from `smartObjectUuid` (the print area the design composites into).
   * When set, "Generate Dynamic Mockups" renders one mockup per offered color,
   * painting THIS smart object with each color while leaving the design clean.
   * When absent, the template renders a single colorless mockup (legacy
   * behavior) regardless of the colors the listing offers.
   *
   * Operator step to enable color-aware renders: in the Dynamic Mockups Library,
   * find the garment/shirt smart object's UUID for this template and paste it
   * here. (The existing `smartObjectUuid` stays the design print area.)
   */
  garmentSmartObjectUuid?: string;
}

// Multiple templates per blueprint — the action renders ALL of them and
// appends every result to mockup_urls so the operator sees all options in
// the carousel. Add more entries here as you collect more mockup styles
// for each blueprint.
const DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT: Record<number, DynamicMockupsTemplate[]> = {
  145: [
    {
      mockupUuid: "0e6cb32a-8602-49ae-937d-620b6d928744",
      smartObjectUuid: "bf4fdfa9-2957-4a51-9c29-bc3034f3df06",
      // To render one mockup per offered color, paste the GARMENT (shirt body)
      // smart object UUID here, e.g.:
      //   garmentSmartObjectUuid: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      // Until then this template renders a single colorless mockup.
    },
    // Add more Gildan 64000 templates here as you find good ones:
    // { mockupUuid: "...", smartObjectUuid: "...", garmentSmartObjectUuid: "..." },
  ],
};

/** Returns all registered templates for a blueprint (empty array if none). */
export function dynamicMockupsTemplates(
  blueprintId: number
): DynamicMockupsTemplate[] {
  return DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT[blueprintId] ?? [];
}

/** Returns the first template for a blueprint — used for the enabled/disabled check. */
export function dynamicMockupsTemplate(
  blueprintId: number
): DynamicMockupsTemplate | undefined {
  return DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT[blueprintId]?.[0];
}
