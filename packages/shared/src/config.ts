import { z } from "zod";

const SettingsSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

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

  // fal.ai
  FAL_KEY: z.string().min(1),

  // Printify
  PRINTIFY_API_TOKEN: z.string().min(1),
  PRINTIFY_SHOP_ID: z.string().min(1),
  // Webhook (optional — set to enable webhook-driven order updates)
  PRINTIFY_WEBHOOK_BASE_URL: z.string().url().optional(),
  PRINTIFY_WEBHOOK_SECRET: z.string().min(32).optional(),

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
  HUMAN_REVIEW_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
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
