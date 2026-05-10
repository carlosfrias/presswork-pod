import retry from "async-retry";
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

async function attemptOnce(path: string, init: RequestInit): Promise<unknown> {
  const { PRINTIFY_API_TOKEN } = getSettings();

  return retry(
    async (bail) => {
      const res = await fetch(`https://api.printify.com/v1${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          "User-Agent": USER_AGENT,
          Authorization: `Bearer ${PRINTIFY_API_TOKEN}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (!res.ok) {
        const body = await res.text();

        if (res.status === 429) {
          const after = res.headers.get("Retry-After");
          const retryAfterMs = after != null ? parseInt(after, 10) * 1000 : undefined;
          bail(new PrintifyError(`Printify 429: rate limited`, 429, retryAfterMs));
          return;
        }

        if (res.status < 500) {
          bail(new PrintifyError(`Printify ${res.status}: ${body}`, res.status));
          return;
        }
        throw new PrintifyError(`Printify ${res.status}: ${body}`, res.status);
      }

      return res.json() as unknown;
    },
    { retries: 3, factor: 2, minTimeout: 500 }
  );
}

export async function printifyFetch(
  path: string,
  init: RequestInit = {},
  opts: { rateClass?: "global" | "publishing" } = {}
): Promise<unknown> {
  const limiter = opts.rateClass === "publishing" ? publishingLimiter : globalLimiter;
  const log = getLogger("printify");

  for (let i = 0; i <= 3; i++) {
    try {
      const result = await limiter.schedule(() => attemptOnce(path, init));
      _recordPrintifyOutcome("success");
      const metrics = getPrintifyErrorRate();
      log.info({ action: "printify_request", path, status: 200, ...metrics });
      return result;
    } catch (err) {
      if (err instanceof PrintifyError && err.status === 429 && i < 3) {
        await _printifyTestHooks.sleep(err.retryAfterMs ?? DEFAULT_429_WAIT_MS);
        continue;
      }
      const outcome =
        err instanceof PrintifyError && (err.status ?? 0) >= 500 ? "5xx" : "4xx";
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

  // 429 exhausted after 3 retries — record as 4xx then throw
  _recordPrintifyOutcome("4xx");
  throw new PrintifyError("Printify: exhausted 429 retries");
}
