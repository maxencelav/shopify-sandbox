import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ordersSummary } from "@sync/db/schema";
import { QUEUES, type ProcessOrderJob } from "@sync/worker";
import { db, getBoss } from "../db.server.ts";

/**
 * Re-enqueues an order, for the retry button of the Polaris screen.
 *
 * Kept out of the route modules: a route file may only export server code
 * through loader/action, otherwise the client bundle would pull in the
 * database client.
 */
export async function requeueOrder(shop: string, shopifyOrderId: string): Promise<boolean> {
  const [summary] = await db
    .select()
    .from(ordersSummary)
    .where(and(eq(ordersSummary.shop, shop), eq(ordersSummary.shopifyOrderId, shopifyOrderId)))
    .limit(1);
  if (!summary) return false;

  const boss = await getBoss();
  await boss.send(QUEUES.processOrder, {
    shop,
    shopifyOrderId,
    shopifyOrderGid: `gid://shopify/Order/${shopifyOrderId}`,
    shopifyOrderName: summary.shopifyOrderName,
    idempotencyKey: summary.idempotencyKey,
    reason: "manual",
    requestId: randomUUID(),
  } satisfies ProcessOrderJob);
  return true;
}
