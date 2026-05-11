import pino, { type Logger } from "pino";
import { getSettings } from "./config.js";

export type { Logger };

const loggers = new Map<string, Logger>();

// Paths pino will mask before emit. Covers (a) HTTP header keys we actually
// log when wrapping fetch responses, (b) token-shaped fields on API payloads,
// and (c) env-shaped keys that get logged on boot or in error context. The `*.`
// variants catch one level of nesting (e.g. log.info({ err, FAL_KEY })).
const REDACT_PATHS = [
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  "*.authorization",
  "*.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "access_token",
  "refresh_token",
  "api_key",
  "apiKey",
  "token",
  "*.access_token",
  "*.refresh_token",
  "*.api_key",
  "*.apiKey",
  "*.token",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "FAL_KEY",
  "PRINTIFY_API_TOKEN",
  "ETSY_API_KEY",
  "ETSY_API_SECRET",
  "ETSY_ACCESS_TOKEN",
  "ETSY_REFRESH_TOKEN",
  "PRINTIFY_WEBHOOK_SECRET",
  "ETSY_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "SLACK_WEBHOOK_URL",
  "*.SUPABASE_SERVICE_ROLE_KEY",
  "*.ANTHROPIC_API_KEY",
  "*.FAL_KEY",
  "*.PRINTIFY_API_TOKEN",
  "*.ETSY_API_KEY",
  "*.ETSY_API_SECRET",
  "*.ETSY_ACCESS_TOKEN",
  "*.ETSY_REFRESH_TOKEN",
  "*.PRINTIFY_WEBHOOK_SECRET",
  "*.ETSY_WEBHOOK_SECRET",
  "*.RESEND_API_KEY",
  "*.SLACK_WEBHOOK_URL",
];

export function getLogger(agent: string): Logger {
  const existing = loggers.get(agent);
  if (existing) return existing;

  const { LOG_LEVEL } = getSettings();
  const logger = pino({
    level: LOG_LEVEL,
    base: { agent },
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
  });
  loggers.set(agent, logger);
  return logger;
}
