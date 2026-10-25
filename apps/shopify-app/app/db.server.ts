import { createDb } from "@sync/db";
import { createQueue } from "@sync/worker";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is missing: check your .env");

export const { db, pool } = createDb(url);

/**
 * One pg-boss instance per process, created on demand.
 * The app never consumes jobs: it only enqueues.
 */
let bossPromise: ReturnType<typeof createQueue> | undefined;
export function getBoss() {
  bossPromise ??= createQueue(url!);
  return bossPromise;
}
