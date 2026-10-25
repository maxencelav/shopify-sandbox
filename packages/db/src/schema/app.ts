import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Raw log of Shopify webhooks.
 *
 * Shopify delivers "at least once": the same webhook can arrive twice.
 * `shopifyWebhookId` (X-Shopify-Webhook-Id header) carries the unique
 * constraint that makes ingestion idempotent: we insert with ON CONFLICT DO
 * NOTHING and answer 200 immediately.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    shopifyWebhookId: text("shopify_webhook_id").notNull(),
    shop: text("shop").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_events_shopify_webhook_id_key").on(t.shopifyWebhookId),
    index("webhook_events_topic_received_at_idx").on(t.topic, t.receivedAt),
  ],
);

export const syncStatuses = ["pending", "synced", "failed", "dead"] as const;
export type SyncStatus = (typeof syncStatuses)[number];

/**
 * Sync state of a Shopify order towards the ERP.
 *
 * One row per order and per shop (unique constraint): the worker upserts, so
 * replaying a job never creates a duplicate.
 */
export const ordersSummary = pgTable(
  "orders_summary",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    shop: text("shop").notNull(),
    shopifyOrderId: text("shopify_order_id").notNull(),
    shopifyOrderName: text("shopify_order_name"),
    /** Key sent to the ERP in Idempotency-Key, stable for a given order. */
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").$type<SyncStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    externalOrderId: text("external_order_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    totalPrice: text("total_price"),
    currency: text("currency"),
    createdAtShopify: timestamp("created_at_shopify", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_summary_shop_order_key").on(t.shop, t.shopifyOrderId),
    index("orders_summary_status_idx").on(t.status),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type OrderSummary = typeof ordersSummary.$inferSelect;
