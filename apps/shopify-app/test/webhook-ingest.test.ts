import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ordersSummary, webhookEvents } from "../../../packages/db/src/schema/app.ts";
import { openDb, resetDatabase } from "../../../test/support/harness.ts";
import { ingestOrderWebhook } from "../app/lib/ingest.server.ts";

const { db, close } = openDb();

const input = (webhookId: string, orderId = 7001) => ({
  webhookId,
  shop: "demo.myshopify.com",
  topic: "orders/create",
  requestId: "req-1",
  payload: {
    id: orderId,
    name: `#${orderId}`,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    total_price: "240.00",
    currency: "EUR",
    created_at: "2026-10-23T09:00:00Z",
  },
});

beforeEach(() => resetDatabase(db));
afterAll(close);

describe("ingestOrderWebhook", () => {
  it("accepts the first webhook and prepares the job", async () => {
    const result = await ingestOrderWebhook(db, input("wh-A"));

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.job.idempotencyKey).toBe("wh-A");
    expect(result.job.shopifyOrderGid).toBe("gid://shopify/Order/7001");

    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    const [summary] = await db.select().from(ordersSummary);
    expect(summary?.status).toBe("pending");
    expect(summary?.totalPrice).toBe("240.00");
  });

  it("ignores the duplicate: a single row in the database", async () => {
    await ingestOrderWebhook(db, input("wh-B"));
    const second = await ingestOrderWebhook(db, input("wh-B"));

    expect(second.status).toBe("duplicate");
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    expect(await db.select().from(ordersSummary)).toHaveLength(1);
  });

  it("withstands two simultaneous deliveries of the same webhook", async () => {
    const results = await Promise.all([
      ingestOrderWebhook(db, input("wh-C")),
      ingestOrderWebhook(db, input("wh-C")),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["accepted", "duplicate"]);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("accepts two distinct webhooks for the same order without duplicating tracking", async () => {
    // Real-world case: Shopify resends the event with a new delivery ID.
    await ingestOrderWebhook(db, input("wh-D1"));
    const second = await ingestOrderWebhook(db, input("wh-D2"));

    expect(second.status).toBe("accepted");
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
    // The unique constraint (shop, shopify_order_id) keeps a single tracking row.
    expect(await db.select().from(ordersSummary)).toHaveLength(1);
  });
});
