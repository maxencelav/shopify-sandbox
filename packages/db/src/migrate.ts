import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb, requireDatabaseUrl } from "./client.ts";

const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString = requireDatabaseUrl()) {
  const { db, pool } = createDb(connectionString, 1);
  try {
    await migrate(db, { migrationsFolder: join(here, "..", "migrations") });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("migrations applied");
}
