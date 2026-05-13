import { getDb } from "./db.js";
import { getLogger, type Logger } from "./logger.js";

// Lazy-init: getLogger() reads env via getSettings(), which validates every
// env var at first call. Module-scope eager init would crash on import when
// a consumer (e.g., a unit test) only sets a subset of env vars.
let _logger: Logger | undefined;
function log(): Logger {
  if (!_logger) _logger = getLogger("shared");
  return _logger;
}

export type LlmProvider = "anthropic" | "fal" | "etsy" | "printify";
export type LlmAgent = "scout" | "builder" | "design" | "listing" | "ledger";

/**
 * Per-1M-token pricing for the Claude models this codebase calls. Source:
 * https://docs.claude.com/en/docs/about-claude/pricing — refresh when models
 * change. Unknown models fall back to Sonnet-4 rates.
 */
const ANTHROPIC_PRICING_USD_PER_MTOK: Record<string, [number, number]> = {
  "claude-sonnet-4-20250514": [3.0, 15.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-opus-4-7": [15.0, 75.0],
  "claude-haiku-4-5-20251001": [1.0, 5.0],
};

export function estimateAnthropicCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
): number {
  const [inputRate, outputRate] =
    ANTHROPIC_PRICING_USD_PER_MTOK[model] ?? [3.0, 15.0];
  return (
    (inputTokens * inputRate +
      outputTokens * outputRate +
      cacheReadInputTokens * inputRate * 0.1 +
      cacheCreationInputTokens * inputRate * 1.25) /
    1_000_000
  );
}

export interface UsageRecord {
  agent: LlmAgent;
  provider: LlmProvider;
  operation: string;
  cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

/**
 * Fire-and-forget consumption log. Never throws — failure to record metrics
 * must not break the pipeline action that triggered the call.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.from("llm_usage").insert({
      agent: record.agent,
      provider: record.provider,
      operation: record.operation,
      cost_usd: record.cost_usd ?? null,
      input_tokens: record.input_tokens ?? null,
      output_tokens: record.output_tokens ?? null,
      metadata: record.metadata ?? null,
      error: record.error ?? null,
    });
    if (error) {
      log().warn({ err: error, record }, "llm_usage insert failed");
    }
  } catch (err) {
    log().warn({ err }, "llm_usage insert threw");
  }
}
