import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://sync:sync@localhost:5433/sync",
  },
  // pg-boss tables live in their own schema, managed by pg-boss.
  schemaFilter: ["public", "erp"],
  verbose: true,
  strict: true,
});
