import {
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The mini-ERP lives in its own schema: a single database to host. */
export const erp = pgSchema("erp");

export const erpOrderStatuses = ["received", "shipped", "cancelled"] as const;
export type ErpOrderStatus = (typeof erpOrderStatuses)[number];

export type ErpOrderLine = {
  sku: string;
  quantity: number;
  unitPrice: string;
  title?: string | undefined;
  /** Line item properties: engraving, gift message (luxury use case). */
  properties?: Record<string, string> | undefined;
};

export type ErpCustomer = {
  name: string;
  email: string;
  phone?: string | undefined;
  address?:
    | {
        line1?: string | undefined;
        city?: string | undefined;
        postalCode?: string | undefined;
        country?: string | undefined;
      }
    | undefined;
};

export const erpOrders = erp.table(
  "erp_orders",
  {
    id: text("id").primaryKey(),
    /** Shopify-side order reference, for correlation. */
    externalReference: text("external_reference").notNull(),
    status: text("status").$type<ErpOrderStatus>().notNull().default("received"),
    customer: jsonb("customer").$type<ErpCustomer>().notNull(),
    lines: jsonb("lines").$type<ErpOrderLine[]>().notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("EUR"),
    trackingNumber: text("tracking_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("erp_orders_external_reference_idx").on(t.externalReference)],
);

export const stock = erp.table("stock", {
  sku: text("sku").primaryKey(),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Stripe-style idempotency.
 *
 * `requestHash` tells "same key, same body" (replay the stored response)
 * apart from "same key, different body" (422).
 */
export const idempotencyKeys = erp.table(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("erp_idempotency_created_at_idx").on(t.createdAt)],
);

/** Chaos mode settings, editable from the admin UI. */
export const chaosSettings = erp.table("chaos_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: integer("enabled").notNull().default(0),
  /** Probability of a 503, as a percentage (0-100). */
  failureRate: integer("failure_rate").notNull().default(30),
  /** Artificial latency added, in milliseconds. */
  latencyMs: integer("latency_ms").notNull().default(0),
  /** Probability of the "lost response" case (stored, then connection dropped). */
  lostResponseRate: integer("lost_response_rate").notNull().default(10),
  /** Probability of a 429 with Retry-After. */
  throttleRate: integer("throttle_rate").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const erpWebhookDeliveries = erp.table(
  "erp_webhook_deliveries",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orderId: text("order_id").notNull(),
    event: text("event").notNull(),
    status: integer("status"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("erp_webhook_deliveries_order_event_key").on(t.orderId, t.event)],
);

/**
 * Log of machine calls (app/worker -> ERP), shown in the UI.
 *
 * One row per request on /api/v1: it tells the full story of an order in
 * chaos mode (503, lost response, replay) under the same idempotency key.
 * No customer data: neither request body nor response.
 */
export const requestOutcomes = [
  "created",
  "replayed",
  "lost_response",
  "unavailable",
  "throttled",
  "rejected",
  "ok",
  "error",
] as const;
export type RequestOutcome = (typeof requestOutcomes)[number];

export const requestLog = erp.table(
  "request_log",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    requestId: text("request_id").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    /** What actually happened, beyond the HTTP status. */
    outcome: text("outcome").$type<RequestOutcome>().notNull(),
    idempotencyKey: text("idempotency_key"),
    /** Structured error code ({ code } from the response), when there is one. */
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("erp_request_log_created_at_idx").on(t.createdAt),
    index("erp_request_log_idempotency_key_idx").on(t.idempotencyKey),
  ],
);

export type ErpOrder = typeof erpOrders.$inferSelect;
export type StockRow = typeof stock.$inferSelect;
export type ChaosSettings = typeof chaosSettings.$inferSelect;
export type RequestLogEntry = typeof requestLog.$inferSelect;
