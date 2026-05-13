import { getDb } from "./db.js";
import { getLogger, type Logger } from "./logger.js";

// Lazy-init: see llm-usage.ts. Avoids eager env validation on import.
let _logger: Logger | undefined;
function log(): Logger {
  if (!_logger) _logger = getLogger("shared");
  return _logger;
}

export type FlagValue = boolean | number | string;

/**
 * Read a runtime flag from the `runtime_flags` table, falling back to the
 * provided default when the row is missing or unreadable. Cached for the
 * lifetime of the process; agents are short-lived crons so they pick up new
 * values on the next run.
 *
 * Values are stored as JSONB so a boolean comes back as `true`, a number as
 * `5.0`, a string as `"birefnet"`. We cast through `FlagValue` to keep callers
 * honest at the type boundary.
 */
const cache = new Map<string, FlagValue>();

export async function getRuntimeFlag<T extends FlagValue>(
  key: string,
  fallback: T,
): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  try {
    const db = getDb();
    const { data, error } = await db
      .from("runtime_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      log().warn({ err: error, key }, "runtime_flag read failed; using fallback");
      cache.set(key, fallback);
      return fallback;
    }
    if (!data) {
      cache.set(key, fallback);
      return fallback;
    }
    const value = data.value as T;
    cache.set(key, value);
    return value;
  } catch (err) {
    log().warn({ err, key }, "runtime_flag read threw; using fallback");
    cache.set(key, fallback);
    return fallback;
  }
}

/** Test-only — clears the in-process cache. */
export function _resetRuntimeFlagCache(): void {
  cache.clear();
}
