import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDb>["db"];
/** A connection or an open transaction: functions taking it can join the caller's transaction. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createDb(connectionString: string, max = 10) {
  const pool = new Pool({ connectionString, max });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

let shared: { db: Database; pool: Pool } | undefined;

/** Connection shared within a process. */
export function getDb(): Database {
  shared ??= createDb(requireDatabaseUrl());
  return shared.db;
}

export async function closeDb(): Promise<void> {
  await shared?.pool.end();
  shared = undefined;
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing: copy .env.example to .env");
  return url;
}
