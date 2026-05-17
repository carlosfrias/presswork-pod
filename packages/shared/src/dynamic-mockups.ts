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
  const body = {
    mockup_uuid: args.mockupUuid,
    smart_objects: [
      {
        uuid: args.smartObjectUuid,
        asset: { url: args.designUrl },
      },
    ],
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
}

const DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT: Record<number, DynamicMockupsTemplate> = {
  // 145: { mockupUuid: "<paste-from-Library>", smartObjectUuid: "<paste-from-Library>" },
};

export function dynamicMockupsTemplate(
  blueprintId: number
): DynamicMockupsTemplate | undefined {
  return DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT[blueprintId];
}
