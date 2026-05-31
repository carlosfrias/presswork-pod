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

  it("exposes the ./publish subpath export backed by an existing source file", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8")
    ) as { exports?: Record<string, { import?: string; types?: string }> };

    const sub = pkg.exports?.["./publish"];
    expect(sub?.import).toBeDefined();
    expect(sub?.types).toBeDefined();

    // `import` points at a compiled artifact (dist/*.js) that only exists after
    // `tsc -b` — CI runs vitest without a build, so we must NOT readFileSync it.
    // Instead validate the build-independent invariant: the export is wired to
    // dist/, and the TypeScript source backing it (types) actually exists.
    expect(sub!.import).toMatch(/^\.\/dist\/.+\.js$/);

    const sourcePath = resolve(here, "..", sub!.types!);
    expect(() => readFileSync(sourcePath, "utf8")).not.toThrow();

    // The artifact path and source path must describe the same module, so a
    // repointed export can't silently pass: dist/<name>.js ⇄ src/<name>.ts.
    const distName = sub!.import!.replace(/^\.\/dist\//, "").replace(/\.js$/, "");
    const srcName = sub!.types!.replace(/^\.\/src\//, "").replace(/\.ts$/, "");
    expect(distName).toBe(srcName);
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
