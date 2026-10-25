import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@sync/db";
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
export async function findReplay(
  db: Database,
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

export async function rememberResponse(
  db: Database,
  key: string,
  requestHash: string,
  status: number,
  body: unknown,
): Promise<void> {
  await db
    .insert(idempotencyKeys)
    .values({ key, requestHash, responseStatus: status, responseBody: body })
    .onConflictDoNothing({ target: idempotencyKeys.key });
}
