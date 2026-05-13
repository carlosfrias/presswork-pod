// Copywriter behavioral evals.
//
// What this catches that unit tests don't:
//   1. Validator regression — if FORBIDDEN_LISTING_TERMS, EXTERNAL_URL_PATTERN,
//      or OFF_PLATFORM_PHRASES get neutered, the edge-* captures stop tripping
//      compliance and the corresponding test fails.
//   2. Schema regression — if ListingCopySchema stops requiring AI disclosure,
//      the edge-ai-disclosure case fails.
//   3. Prompt drift — the SYSTEM_PROMPT snapshot below forces a deliberate
//      `vitest --update` whenever the prompt source text changes.
//
// What this does NOT catch in replay mode: live model drift. To detect drift,
// run with EVAL_LIVE=1 — that path hits Anthropic and rewrites the captures.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const CAPTURES_DIR = join(__dirname, "__captures__");
const COPYWRITER_SRC = join(__dirname, "..", "..", "src", "copywriter.ts");

const EVAL_LIVE = process.env["EVAL_LIVE"] === "1";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

interface Fixture {
  name: string;
  description: string;
  brief: Record<string, unknown>;
  design: Record<string, unknown>;
  expect: {
    writeCopySucceeds: boolean;
    writeCopyErrorName?: string;
    compliancePasses?: boolean;
    complianceErrorIncludes?: string;
  };
}

interface Capture {
  text: string;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as Fixture;
}

function loadCapture(name: string): Capture {
  return JSON.parse(readFileSync(join(CAPTURES_DIR, `${name}.json`), "utf8")) as Capture;
}

function saveCapture(name: string, text: string): void {
  const path = join(CAPTURES_DIR, `${name}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        model: "claude-sonnet-4-20250514",
        captured_at: new Date().toISOString(),
        note: "Auto-regenerated via EVAL_LIVE=1.",
        text,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function makeAnthropicMock(responseText: string) {
  return {
    default: vi.fn().mockReturnValue({
      beta: {
        promptCaching: {
          messages: {
            create: vi.fn().mockResolvedValue({
              content: [{ type: "text", text: responseText }],
            }),
          },
        },
      },
    }),
  };
}

const FIXTURE_NAMES = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe.each(FIXTURE_NAMES)("copywriter eval: %s", (name) => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("matches expected writeCopy + compliance behavior", async () => {
    const fixture = loadFixture(name);
    const capture = EVAL_LIVE ? null : loadCapture(name);

    if (!EVAL_LIVE && capture) {
      vi.doMock("@anthropic-ai/sdk", () => makeAnthropicMock(capture.text));
    }
    // EVAL_LIVE: leave the SDK un-mocked. process.env.ANTHROPIC_API_KEY must be
    // a real key (loaded via .env in your shell). The captured-mode tests above
    // run independently in the default mode used by CI.

    const { writeCopy, CopywriterError } = await import("../../src/copywriter.js");
    const { validateCopyCompliance, ComplianceError } = await import(
      "../../src/compliance.js"
    );

    let copy: Awaited<ReturnType<typeof writeCopy>> | undefined;
    let writeError: unknown;
    try {
      copy = await writeCopy(
        fixture.brief as Parameters<typeof writeCopy>[0],
        fixture.design as Parameters<typeof writeCopy>[1]
      );
    } catch (e) {
      writeError = e;
    }

    if (fixture.expect.writeCopySucceeds) {
      expect(writeError, `writeCopy unexpectedly threw: ${String(writeError)}`).toBeUndefined();
      expect(copy).toBeDefined();
    } else {
      expect(writeError, "writeCopy was expected to throw").toBeDefined();
      if (fixture.expect.writeCopyErrorName === "CopywriterError") {
        expect(writeError).toBeInstanceOf(CopywriterError);
      }
      // Edge cases that expected a writeCopy failure end here; no compliance to check.
      // Live-mode capture refresh requires a successful call, so skip the rewrite below.
      return;
    }

    if (!copy) throw new Error("unreachable: copy is defined when writeCopySucceeds=true");

    let complianceError: unknown;
    try {
      validateCopyCompliance(copy);
    } catch (e) {
      complianceError = e;
    }

    if (fixture.expect.compliancePasses) {
      expect(
        complianceError,
        `compliance unexpectedly failed: ${String(complianceError)}`
      ).toBeUndefined();
    } else {
      expect(complianceError, "compliance was expected to fail").toBeDefined();
      expect(complianceError).toBeInstanceOf(ComplianceError);
      if (fixture.expect.complianceErrorIncludes) {
        const msg = String((complianceError as Error).message).toLowerCase();
        expect(msg).toContain(fixture.expect.complianceErrorIncludes.toLowerCase());
      }
    }

    // EVAL_LIVE mode: refresh the capture file with this run's model output.
    // The capture is the raw JSON text Claude returned; we serialize the
    // already-parsed copy back so the next replayed run sees the latest shape.
    if (EVAL_LIVE && copy) {
      saveCapture(name, JSON.stringify(copy));
    }
  });
});

describe("copywriter prompt snapshot", () => {
  it("SYSTEM_PROMPT matches snapshot — refresh with `vitest --update` after deliberate edits", () => {
    // Snapshot the SYSTEM_PROMPT block from copywriter.ts source so a prompt
    // edit forces an explicit `vitest --update`. We snapshot from source text
    // (regex extract) rather than importing the const, since it isn't exported
    // — and we don't want to add an export purely for the eval.
    const src = readFileSync(COPYWRITER_SRC, "utf8");
    const match = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match, "could not locate SYSTEM_PROMPT in copywriter.ts").not.toBeNull();
    expect(match![1]).toMatchSnapshot();
  });
});
