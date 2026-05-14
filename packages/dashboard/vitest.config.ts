import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      "@presswork/shared": resolve(__dirname, "../shared/src/index.ts"),
      // `server-only` throws at import time outside a server component. In
      // vitest there's no client/server boundary, so swap it for a no-op.
      "server-only": resolve(__dirname, "tests/helpers/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
