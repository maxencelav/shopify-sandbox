import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["apps/*/test/**/*.test.ts"],
    // A single Postgres for the whole suite: tests share the container
    // and clean the tables between each case.
    pool: "forks",
    // Files share the same Postgres: never in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    environment: "node",
    // Loggers read process.env when the module loads.
    env: { LOG_LEVEL: "silent", NODE_ENV: "test" },
  },
  esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" },
});
