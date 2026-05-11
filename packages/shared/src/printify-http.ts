import Bottleneck from "bottleneck";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./config.js";
import { getLogger } from "./logger.js";
import { _recordPrintifyOutcome, getPrintifyErrorRate } from "./printify-metrics.js";

const _pkgVersion = (() => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(dir, "../package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();

export const USER_AGENT = `presswork/${_pkgVersion}`;
export const DEFAULT_429_WAIT_MS = 5_000;

// Unified retry budget across 429 and 5xx so the total outgoing request count
// matches CLAUDE.md's "max 3 retries" contract instead of the previous nested
// loops which could fan out to 4×4 in worst-case mixed-error scenarios.
export const MAX_ATTEMPTS = 3;

// Cap Retry-After parsing so a misbehaving header can't stall the publish
// pipeline for an hour (single-concurrency limiter).
const MAX_RETRY_AFTER_MS = 60_000;

export class PrintifyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (header == null) return null;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

// Exported for test spying — swap out `sleep` to make 429 retry tests instant
export const _printifyTestHooks = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Global limiter: maxConcurrent 4, minTime 110ms ≈ 540 req/min (under 600/min ceiling)
const globalLimiter = new Bottleneck({ maxConcurrent: 4, minTime: 110 });

// Publishing limiter: 180 req/30 min (under 200/30 min ceiling), chained through global
// so publishing calls satisfy BOTH rate constraints simultaneously.
const publishingLimiter = new Bottleneck({
  reservoir: 180,
  reservoirRefreshInterval: 30 * 60 * 1000,
  reservoirRefreshAmount: 180,
}).chain(globalLimiter);

// Single unified retry loop: at most MAX_ATTEMPTS outgoing requests regardless
// of whether the failures are 429, 5xx, or a mix. Previously nested loops
// (outer 429 retries × inner async-retry on 5xx) could exceed the documented
// retry budget; this collapses them.
async function attemptWithRetry(path: string, init: RequestInit): Promise<unknown> {
  const { PRINTIFY_API_TOKEN } = getSettings();
  let lastErr: PrintifyError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`https://api.printify.com/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${PRINTIFY_API_TOKEN}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (res.ok) {
      return res.json() as unknown;
    }

    const body = await res.text();

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      lastErr = new PrintifyError(
        `Printify 429: rate limited`,
        429,
        retryAfterMs ?? undefined
      );
      if (attempt === MAX_ATTEMPTS - 1) break;
      await _printifyTestHooks.sleep(retryAfterMs ?? DEFAULT_429_WAIT_MS);
      continue;
    }

    if (res.status < 500) {
      // Non-retryable client error
      throw new PrintifyError(`Printify ${res.status}: ${body}`, res.status);
    }

    // 5xx — retry with exponential backoff (matches the prior async-retry timing)
    lastErr = new PrintifyError(`Printify ${res.status}: ${body}`, res.status);
    if (attempt === MAX_ATTEMPTS - 1) break;
    await _printifyTestHooks.sleep(500 * Math.pow(2, attempt));
  }

  throw lastErr ?? new PrintifyError("Printify: exhausted retries");
}

export async function printifyFetch(
  path: string,
  init: RequestInit = {},
  opts: { rateClass?: "global" | "publishing" } = {}
): Promise<unknown> {
  const limiter = opts.rateClass === "publishing" ? publishingLimiter : globalLimiter;
  const log = getLogger("printify");

  try {
    const result = await limiter.schedule(() => attemptWithRetry(path, init));
    _recordPrintifyOutcome("success");
    const metrics = getPrintifyErrorRate();
    log.info({ action: "printify_request", path, status: 200, ...metrics });
    return result;
  } catch (err) {
    const outcome =
      err instanceof PrintifyError && (err.status ?? 0) >= 500
        ? "5xx"
        : "4xx";
    _recordPrintifyOutcome(outcome);
    const metrics = getPrintifyErrorRate();
    log.info({
      action: "printify_request",
      path,
      status: err instanceof PrintifyError ? err.status : undefined,
      ...metrics,
    });
    throw err;
  }
}
