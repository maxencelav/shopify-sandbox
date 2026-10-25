import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "../packages/db/src/migrate.ts";

/**
 * A real Postgres database for the tests, through Testcontainers.
 *
 * A database mock proves nothing about what matters here: unique
 * constraints, transactions and row locks. That is exactly what we want to
 * test.
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("sync_test")
    .withUsername("sync")
    .withPassword("sync")
    .start();

  const url = container.getConnectionUri();
  await runMigrations(url);
  // The global setup runs before the workers start: they inherit this
  // environment variable.
  process.env.TEST_DATABASE_URL = url;
}

export async function teardown() {
  await container?.stop();
}
