import { z } from "zod";

// MOCK_PLACEHOLDER is the only value allowed for Etsy OAuth fields when
// ETSY_MOCK_MODE=true. Using a fixed sentinel (rather than free-form text)
// makes "is this a real cred or a placeholder?" trivially answerable in logs
// and config diffs, and lets the cross-field refinement below fail loudly if
// a mock placeholder is left in place after mock mode is flipped off.
export const ETSY_MOCK_PLACEHOLDER = "mock";

const SettingsSchema = z
  .object({
    // Anthropic
    ANTHROPIC_API_KEY: z.string().min(1),

    // Etsy mock mode — when "true", the shared Etsy HTTP client returns
    // canned fixtures from etsy-mock.ts instead of calling api.etsy.com,
    // and getValidAccessToken returns a mock token without POSTing to
    // /oauth/token. Lets the listing pipeline run end-to-end before real
    // Etsy credentials are issued. See CLAUDE.md → Listing Agent.
    ETSY_MOCK_MODE: z
      .string()
      .optional()
      .default("false")
      .transform((v) => v === "true"),

    // Etsy
    ETSY_API_KEY: z.string().min(1),
    ETSY_API_SECRET: z.string().min(1),
    ETSY_SHOP_ID: z.string().min(1),
    ETSY_ACCESS_TOKEN: z.string().min(1),
    ETSY_REFRESH_TOKEN: z.string().min(1),
    ETSY_SHIPPING_PROFILE_ID: z.coerce.number().int(),
    // Etsy production-partner ID for Printify. Required by Etsy POD policy on
    // every listing. Register Printify in Etsy Shop Manager → Production Partners,
    // then put the returned numeric ID here. See compliance section in CLAUDE.md.
    ETSY_PRODUCTION_PARTNER_ID: z.coerce.number().int().positive(),
    // Required on all physical listings as of Sep 30 2025 (Processing Profiles migration).
    // Run scripts/get_etsy_readiness_state.ts once to get this ID, then paste it here.
    ETSY_READINESS_STATE_ID: z.coerce.number().int().positive(),
    // Provided by Etsy when the webhook subscription is created. Format: whsec_<base64>.
    // Required for live webhook verification; optional so tests without webhooks don't fail.
    ETSY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // fal.ai
  FAL_KEY: z.string().min(1),

  // Printify
  PRINTIFY_API_TOKEN: z.string().min(1),
  PRINTIFY_SHOP_ID: z.string().min(1),
  // Webhook (optional — set to enable webhook-driven order updates)
  PRINTIFY_WEBHOOK_BASE_URL: z.string().url().optional(),
  PRINTIFY_WEBHOOK_SECRET: z.string().min(32).optional(),

  // Dynamic Mockups — alternative listing-image provider used by the
  // dashboard's "Generate Dynamic Mockups" button. Optional: pipeline
  // works without it (Printify mockups are the default). Format is the
  // literal "client_id:secret_key" string Dynamic Mockups gives you,
  // sent verbatim in the x-api-key header.
  DYNAMIC_MOCKUPS_API_KEY: z.string().min(1).optional(),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Alerts
  RESEND_API_KEY: z.string().min(1),
  ALERT_EMAIL: z.string().email(),
  SLACK_WEBHOOK_URL: z.string().url(),

    // Runtime
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  })
  .superRefine((cfg, ctx) => {
    // When mock mode is OFF, refuse to accept the placeholder sentinel.
    // Otherwise a forgotten ETSY_MOCK_MODE flip would silently 401 against
    // openapi.etsy.com — much worse than failing fast at boot.
    if (!cfg.ETSY_MOCK_MODE) {
      const oauthFields = [
        "ETSY_API_KEY",
        "ETSY_API_SECRET",
        "ETSY_ACCESS_TOKEN",
        "ETSY_REFRESH_TOKEN",
      ] as const;
      for (const field of oauthFields) {
        if (cfg[field] === ETSY_MOCK_PLACEHOLDER) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is set to the mock placeholder "${ETSY_MOCK_PLACEHOLDER}" but ETSY_MOCK_MODE is off. Either set ETSY_MOCK_MODE=true or paste a real value.`,
          });
        }
      }
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;

let _cached: Settings | undefined;

export function getSettings(): Settings {
  if (_cached) return _cached;
  const result = SettingsSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing or invalid environment variables:\n${issues}`);
  }
  _cached = result.data;
  return _cached;
}
