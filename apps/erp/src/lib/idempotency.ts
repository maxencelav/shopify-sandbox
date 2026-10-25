import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database, Executor } from "@sync/db";
import { idempotencyKeys } from "@sync/db/schema";
import { idempotencyKeyReused } from "./errors.ts";

export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Deterministic JSON: key order must not change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export type Replay = { status: number; body: unknown };

/**
 * Stripe-style idempotency.
 *
 * - unknown key            -> null, the caller processes the request
 * - key + same body        -> replay the stored response
 * - key + different body   -> 422
 */
async function findReplay(
  db: Executor,
  key: string,
  requestHash: string,
): Promise<Replay | null> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (!row) return null;
  if (row.requestHash !== requestHash) throw idempotencyKeyReused();
  return { status: row.responseStatus, body: row.responseBody };
}

/**
 * Runs `handle` at most once per key.
 *
 * Everything happens in one transaction holding an advisory lock on the key:
 * a concurrent request with the same key waits, then finds the stored
 * response and replays it instead of creating a second order. The response is
 * stored in the same transaction as the work, so a crash cannot leave an order
 * without its key.
 *
 * `handle` errors (unknown SKU, out of stock) roll everything back and store
 * nothing: the same key can be retried once the cause is fixed.
 */
export async function runIdempotent(
  db: Database,
  key: string,
  requestHash: string,
  handle: (tx: Executor) => Promise<{ status: number; body: unknown }>,
): Promise<{ replayed: boolean; status: number; body: unknown }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const replay = await findReplay(tx, key, requestHash);
    if (replay) return { replayed: true, ...replay };

    const { status, body } = await handle(tx);
    await tx
      .insert(idempotencyKeys)
      .values({ key, requestHash, responseStatus: status, responseBody: body });
    return { replayed: false, status, body };
  });
}
