import { eq } from "drizzle-orm";
import type { Database } from "@sync/db";
import { chaosSettings, type ChaosSettings } from "@sync/db/schema";
import { throttled, unavailable } from "./errors.ts";

export type ChaosDecision = "ok" | "lost_response";

const DEFAULTS: ChaosSettings = {
  id: 1,
  enabled: 0,
  failureRate: 30,
  latencyMs: 0,
  lostResponseRate: 10,
  throttleRate: 0,
  updatedAt: new Date(0),
};

export async function readChaos(db: Database): Promise<ChaosSettings> {
  const [row] = await db.select().from(chaosSettings).where(eq(chaosSettings.id, 1)).limit(1);
  return row ?? DEFAULTS;
}

export async function setChaos(
  db: Database,
  patch: Partial<Omit<ChaosSettings, "id" | "updatedAt">>,
): Promise<ChaosSettings> {
  const [row] = await db
    .insert(chaosSettings)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({
      target: chaosSettings.id,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return row ?? DEFAULTS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hits = (percent: number, random: () => number) => random() * 100 < percent;

/**
 * Applies chaos BEFORE the write (503, 429, latency) and tells whether the
 * response must be "lost" AFTER the write.
 *
 * The "lost response" case is the one that matters: the ERP did store the
 * order, but the client receives nothing and retries. Only the idempotency
 * key prevents the duplicate.
 */
export async function applyChaos(
  settings: ChaosSettings,
  random: () => number = Math.random,
): Promise<ChaosDecision> {
  if (!settings.enabled) return "ok";
  if (settings.latencyMs > 0) await sleep(settings.latencyMs);
  if (hits(settings.throttleRate, random)) throw throttled(2);
  if (hits(settings.failureRate, random)) throw unavailable("Simulated outage (chaos mode)");
  return hits(settings.lostResponseRate, random) ? "lost_response" : "ok";
}

/** Thrown to simulate a connection dropped before the response. */
export class LostResponseError extends Error {
  constructor() {
    super("Lost response: the order is stored but the client received nothing");
    this.name = "LostResponseError";
  }
}
