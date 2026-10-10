import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Examples import "planwright-e2e"; test them against the source, not a stale build.
  resolve: {
    alias: [
      { find: /^planwright-e2e$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
      { find: /^planwright-e2e\/judge\/laya$/, replacement: fileURLToPath(new URL("./src/judge/laya.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // e2e tests share one demo server per file and run their scenarios serially.
    fileParallelism: false,
  },
});
