import type { Database } from "@sync/db";
import { ordersSummary, webhookEvents } from "@sync/db/schema";
import type { ProcessOrderJob } from "@sync/worker";

export type ShopifyOrderWebhook = {
  id: number | string;
  name?: string;
  admin_graphql_api_id?: string;
  total_price?: string;
  currency?: string;
  created_at?: string;
};

export type IngestResult =
  | { status: "duplicate"; shopifyOrderId: string }
  | { status: "accepted"; shopifyOrderId: string; job: ProcessOrderJob };

/**
 * Ingestion of an orders/create webhook, extracted from the route so it can be
 * tested without a Shopify server.
 *
 * The unique constraint on `shopify_webhook_id` does all the work: the
 * database decides whether the event is new, not a `select` followed by an
 * `insert` (which would leave a race window between the two).
 */
export async function ingestOrderWebhook(
  db: Database,
  input: {
    webhookId: string;
    shop: string;
    topic: string;
    payload: ShopifyOrderWebhook;
    requestId: string;
  },
): Promise<IngestResult> {
  const shopifyOrderId = String(input.payload.id);

  const inserted = await db
    .insert(webhookEvents)
    .values({
      shopifyWebhookId: input.webhookId,
      shop: input.shop,
      topic: input.topic,
      payload: input.payload as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: webhookEvents.shopifyWebhookId })
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) return { status: "duplicate", shopifyOrderId };

  await db
    .insert(ordersSummary)
    .values({
      shop: input.shop,
      shopifyOrderId,
      shopifyOrderName: input.payload.name ?? null,
      idempotencyKey: input.webhookId,
      status: "pending",
      totalPrice: input.payload.total_price ?? null,
      currency: input.payload.currency ?? null,
      createdAtShopify: input.payload.created_at ? new Date(input.payload.created_at) : null,
    })
    .onConflictDoUpdate({
      target: [ordersSummary.shop, ordersSummary.shopifyOrderId],
      set: { updatedAt: new Date() },
    });

  return {
    status: "accepted",
    shopifyOrderId,
    job: {
      shop: input.shop,
      shopifyOrderId,
      shopifyOrderGid:
        input.payload.admin_graphql_api_id ?? `gid://shopify/Order/${shopifyOrderId}`,
      shopifyOrderName: input.payload.name ?? null,
      idempotencyKey: input.webhookId,
      reason: "webhook",
      requestId: input.requestId,
    },
  };
}
