import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Database } from "@sync/db";
import { ordersSummary, webhookEvents } from "@sync/db/schema";
import { ErpRequestError, type CreateOrderPayload, type ErpClient } from "../lib/erp-client.ts";
import { logger } from "../lib/logger.ts";
import { QUEUES, type ProcessOrderJob } from "../queue.ts";
import type { AdminClient, OrderWebhookPayload } from "../lib/shopify-admin.ts";

export type ProcessOrderDeps = {
  db: Database;
  erp: ErpClient;
  boss: PgBoss;
  admin?: AdminClient | undefined;
};

export type ProcessOutcome =
  | { result: "synced"; erpOrderId: string }
  | { result: "already_synced"; erpOrderId: string }
  | { result: "dead"; code: string }
  | { result: "retry_scheduled"; afterSeconds: number };

/**
 * Order processing.
 *
 * Three properties to keep in mind:
 * 1. idempotent towards the ERP (stable Idempotency-Key per order);
 * 2. idempotent in the database (upsert on (shop, shopify_order_id));
 * 3. a permanent error triggers no retry: it goes to the dead-letter queue
 *    with its reason, because retrying an out-of-stock will not fix it.
 */
export async function processOrder(
  deps: ProcessOrderDeps,
  job: ProcessOrderJob,
): Promise<ProcessOutcome> {
  const { db, erp, boss, admin } = deps;
  const log = logger.child({ requestId: job.requestId, shopifyOrderId: job.shopifyOrderId });

  const [summary] = await db
    .select()
    .from(ordersSummary)
    .where(eq(ordersSummary.shopifyOrderId, job.shopifyOrderId))
    .limit(1);

  if (summary?.status === "synced" && summary.externalOrderId) {
    log.info({ erpOrderId: summary.externalOrderId }, "order.already_synced");
    return { result: "already_synced", erpOrderId: summary.externalOrderId };
  }

  const payload = await buildPayload(db, admin, job);
  if (!payload) {
    await markDead(db, job, "payload_not_found");
    await boss.send(QUEUES.processOrderDead, { ...job, reasonCode: "payload_not_found" });
    return { result: "dead", code: "payload_not_found" };
  }

  await db
    .update(ordersSummary)
    .set({ attempts: sql`${ordersSummary.attempts} + 1`, updatedAt: new Date() })
    .where(eq(ordersSummary.shopifyOrderId, job.shopifyOrderId));

  try {
    const { body } = await erp.createOrder(payload, job.idempotencyKey, job.requestId);
    const syncedAt = new Date();

    await db
      .insert(ordersSummary)
      .values({
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        shopifyOrderName: job.shopifyOrderName,
        idempotencyKey: job.idempotencyKey,
        status: "synced",
        externalOrderId: body.id,
        syncedAt,
        totalPrice: body.total,
        currency: body.currency,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: [ordersSummary.shop, ordersSummary.shopifyOrderId],
        set: {
          status: "synced",
          externalOrderId: body.id,
          syncedAt,
          lastError: null,
          updatedAt: syncedAt,
        },
      });

    // Trace on the Shopify side: external ID and sync date as metafields.
    if (admin) {
      try {
        await admin.writeSyncMetafields(job.shopifyOrderGid, body.id, syncedAt);
      } catch (error) {
        // The ERP has the order: do not rerun the whole job for a metafield.
        log.warn({ err: error }, "metafields.write_failed");
      }
    }

    log.info({ erpOrderId: body.id }, "order.synced");
    return { result: "synced", erpOrderId: body.id };
  } catch (error) {
    if (!(error instanceof ErpRequestError)) throw error;

    if (!error.retryable) {
      await markDead(db, job, `${error.code}: ${error.message}`);
      await boss.send(QUEUES.processOrderDead, { ...job, reasonCode: error.code });
      log.warn({ code: error.code }, "order.permanent_error");
      return { result: "dead", code: error.code };
    }

    await db
      .update(ordersSummary)
      .set({ status: "failed", lastError: error.message, updatedAt: new Date() })
      .where(eq(ordersSummary.shopifyOrderId, job.shopifyOrderId));

    // 429 with Retry-After: honor the requested delay instead of pg-boss's
    // generic backoff, by re-enqueuing the job with startAfter.
    if (error.retryAfterSeconds) {
      await boss.send(QUEUES.processOrder, job, { startAfter: error.retryAfterSeconds });
      log.warn({ afterSeconds: error.retryAfterSeconds }, "order.throttled_retry_scheduled");
      return { result: "retry_scheduled", afterSeconds: error.retryAfterSeconds };
    }

    // Temporary error: rethrow, pg-boss applies its backoff.
    throw error;
  }
}

async function buildPayload(
  db: Database,
  admin: AdminClient | undefined,
  job: ProcessOrderJob,
): Promise<CreateOrderPayload | null> {
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.shopifyWebhookId, job.idempotencyKey))
    .limit(1);

  // No stored webhook: the order was found by reconciliation, read it from
  // the Admin API instead.
  const order =
    (event?.payload as OrderWebhookPayload | undefined) ??
    (await admin?.fetchOrder(job.shopifyOrderGid)) ??
    null;
  if (!order) return null;

  return {
    externalReference: job.shopifyOrderName ?? job.shopifyOrderId,
    customer: {
      name:
        [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") ||
        order.email ||
        "Unknown customer",
      email: order.customer?.email ?? order.email ?? "unknown@example.com",
      ...(order.shipping_address?.phone ? { phone: order.shipping_address.phone } : {}),
      address: {
        ...(order.shipping_address?.address1 ? { line1: order.shipping_address.address1 } : {}),
        ...(order.shipping_address?.city ? { city: order.shipping_address.city } : {}),
        ...(order.shipping_address?.zip ? { postalCode: order.shipping_address.zip } : {}),
        ...(order.shipping_address?.country ? { country: order.shipping_address.country } : {}),
      },
    },
    lines: (order.line_items ?? []).map((item) => ({
      // Shopify sends an empty string, not null, for a variant without a SKU.
      sku: item.sku || `UNKNOWN-${item.id}`,
      quantity: item.quantity,
      unitPrice: item.price,
      ...(item.title ? { title: item.title } : {}),
      // Luxury use case: engraving, gift message.
      ...(item.properties?.length
        ? {
            properties: Object.fromEntries(
              item.properties.filter((p) => p.name && p.value).map((p) => [p.name, p.value]),
            ),
          }
        : {}),
    })),
    currency: order.currency ?? "EUR",
  };
}

async function markDead(db: Database, job: ProcessOrderJob, reason: string) {
  await db
    .update(ordersSummary)
    .set({ status: "dead", lastError: reason, updatedAt: new Date() })
    .where(eq(ordersSummary.shopifyOrderId, job.shopifyOrderId));
}
