import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { resumePublish } from "./publish.js";

// Regression guard for the dashboard's per-listing "Publish to Etsy" action.
// The dashboard imports `@presswork/listing/publish`; if that subpath export is
// dropped or repointed at a missing file, Next fails at build time with
// "Can't resolve …". These checks fail fast in unit tests instead.
const here = dirname(fileURLToPath(import.meta.url));

describe("@presswork/listing/publish entrypoint", () => {
  it("re-exports resumePublish as a callable", () => {
    expect(typeof resumePublish).toBe("function");
  });

  it("exposes the ./publish subpath export pointing at an existing file", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8")
    ) as { exports?: Record<string, { import?: string; types?: string }> };

    const sub = pkg.exports?.["./publish"];
    expect(sub?.import).toBeDefined();

    // The referenced source file must exist (relative to the package root).
    const target = resolve(here, "..", sub!.import!);
    expect(() => readFileSync(target, "utf8")).not.toThrow();
  });

  it("does not route the dashboard through the agent poll-loop barrel", () => {
    // publish.ts must stay decoupled from index.ts/poller.js so importers don't
    // pull the agent run-loop into their bundle. Check import statements only,
    // not comment prose that may mention these names.
    const src = readFileSync(resolve(here, "publish.ts"), "utf8");
    const importLines = src
      .split("\n")
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/["'][^"']*poller/);
      expect(line).not.toMatch(/["']\.\/index/);
    }
  });
});
