import pino, { type Logger } from "pino";
import { getSettings } from "./config.js";

export type { Logger };

const loggers = new Map<string, Logger>();

export function getLogger(agent: string): Logger {
  const existing = loggers.get(agent);
  if (existing) return existing;

  const { LOG_LEVEL } = getSettings();
  const logger = pino({
    level: LOG_LEVEL,
    base: { agent },
  });
  loggers.set(agent, logger);
  return logger;
}
