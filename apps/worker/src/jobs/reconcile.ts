import { and, eq, gte, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Database } from "@sync/db";
import { ordersSummary } from "@sync/db/schema";
import { logger } from "../lib/logger.ts";
import { QUEUES, orderIdempotencyKey, type ReconcileJob } from "../queue.ts";
import type { AdminClient } from "../lib/shopify-admin.ts";

export type ReconcileDeps = { db: Database; boss: PgBoss; admin: AdminClient };

/**
 * Nightly reconciliation.
 *
 * This answers "what if Shopify misses a webhook?". Shopify guarantees
 * "at least once", not "exactly once": a webhook can be lost (app down,
 * Shopify running out of retries). We compare the orders from the last 24 h
 * seen by the Admin API with what we processed, and re-enqueue what is
 * missing.
 *
 * The job is idempotent: re-enqueuing an already synced order creates no
 * duplicate (processOrder exits right away, and the ERP has the key).
 */
export async function reconcileOrders(
  deps: ReconcileDeps,
  job: ReconcileJob,
): Promise<{ scanned: number; requeued: number }> {
  const { db, boss, admin } = deps;
  const since = new Date(Date.now() - job.lookbackHours * 3600_000);
  const log = logger.child({ job: "reconcile", shop: job.shop, since: since.toISOString() });

  const shopifyOrders: { id: string; name: string }[] = [];
  for await (const order of admin.iterateRecentOrders(since)) {
    shopifyOrders.push({ id: order.id, name: order.name });
  }
  if (shopifyOrders.length === 0) {
    log.info("reconcile.no_orders");
    return { scanned: 0, requeued: 0 };
  }

  const numericIds = shopifyOrders.map((o) => gidToId(o.id));
  const known = await db
    .select({ id: ordersSummary.shopifyOrderId, status: ordersSummary.status })
    .from(ordersSummary)
    .where(
      and(
        eq(ordersSummary.shop, job.shop),
        inArray(ordersSummary.shopifyOrderId, numericIds),
        gte(ordersSummary.updatedAt, since),
      ),
    );

  const syncedIds = new Set(known.filter((k) => k.status === "synced").map((k) => k.id));
  const deadIds = new Set(known.filter((k) => k.status === "dead").map((k) => k.id));

  let requeued = 0;
  for (const order of shopifyOrders) {
    const id = gidToId(order.id);
    // Dead-lettered orders are deliberately skipped: they need a human
    // decision (out of stock, unknown SKU).
    if (syncedIds.has(id) || deadIds.has(id)) continue;

    await db
      .insert(ordersSummary)
      .values({
        shop: job.shop,
        shopifyOrderId: id,
        shopifyOrderName: order.name,
        idempotencyKey: orderIdempotencyKey(job.shop, id),
        status: "pending",
      })
      .onConflictDoNothing({ target: [ordersSummary.shop, ordersSummary.shopifyOrderId] });

    await boss.send(QUEUES.processOrder, {
      shop: job.shop,
      shopifyOrderId: id,
      shopifyOrderGid: order.id,
      shopifyOrderName: order.name,
      idempotencyKey: orderIdempotencyKey(job.shop, id),
      reason: "reconcile",
      requestId: `reconcile-${id}`,
    });
    requeued += 1;
  }

  log.info({ scanned: shopifyOrders.length, requeued }, "reconcile.completed");
  return { scanned: shopifyOrders.length, requeued };
}

export function gidToId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}
