/**
 * Demo without a Shopify store: simulates an incoming orders/create webhook.
 *
 *   npm run demo              # one order, healthy ERP
 *   npm run demo -- --chaos   # chaos mode on: outages, latency, lost response
 *   npm run demo -- --oos     # out-of-stock order (dead-letter)
 *
 * Inserts the event the way the webhook route would, then enqueues the job.
 * The worker (npm run dev:worker) does the rest.
 */
import { randomUUID } from "node:crypto";
import { createDb, requireDatabaseUrl } from "../packages/db/src/client.ts";
import { ordersSummary, webhookEvents } from "../packages/db/src/schema/app.ts";
import { setChaos } from "../apps/erp/src/lib/chaos.ts";
import { QUEUES, createQueue, type ProcessOrderJob } from "../apps/worker/src/queue.ts";

const args = new Set(process.argv.slice(2));
const url = requireDatabaseUrl();
const { db, pool } = createDb(url, 2);
const boss = await createQueue(url);

const shop = process.env.SHOPIFY_SHOP ?? "demo.myshopify.com";
const webhookId = `demo-${randomUUID()}`;
const orderId = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
const outOfStock = args.has("--oos");

if (args.has("--chaos")) {
  await setChaos(db, {
    enabled: 1,
    failureRate: 50,
    latencyMs: 300,
    lostResponseRate: 25,
    throttleRate: 0,
  });
  console.log("chaos mode on: 50% 503s, 25% lost responses, 300 ms latency");
} else {
  await setChaos(db, { enabled: 0 });
}

const payload = {
  id: Number(orderId),
  name: `#${orderId}`,
  admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
  currency: "EUR",
  total_price: outOfStock ? "9000.00" : "360.00",
  created_at: new Date().toISOString(),
  customer: { first_name: "Marie", last_name: "Dupont", email: "marie.dupont@example.com" },
  shipping_address: {
    address1: "12 rue de la Paix",
    city: "Paris",
    zip: "75002",
    country: "France",
    phone: "+33612345678",
  },
  line_items: outOfStock
    ? [{ id: 1, sku: "CA-WATCH-002", title: "Rose gold watch", quantity: 99, price: "9000.00" }]
    : [
        {
          id: 1,
          sku: "LV-SCARF-001",
          title: "Printed silk scarf",
          quantity: 2,
          price: "180.00",
          properties: [{ name: "Gravure", value: "M.L." }],
        },
      ],
};

await db.insert(webhookEvents).values({
  shopifyWebhookId: webhookId,
  shop,
  topic: "orders/create",
  payload,
});

await db
  .insert(ordersSummary)
  .values({
    shop,
    shopifyOrderId: orderId,
    shopifyOrderName: payload.name,
    idempotencyKey: webhookId,
    status: "pending",
    totalPrice: payload.total_price,
    currency: payload.currency,
    createdAtShopify: new Date(payload.created_at),
  })
  .onConflictDoNothing();

const job: ProcessOrderJob = {
  shop,
  shopifyOrderId: orderId,
  shopifyOrderGid: payload.admin_graphql_api_id,
  shopifyOrderName: payload.name,
  idempotencyKey: webhookId,
  reason: "webhook",
  requestId: randomUUID(),
};

await boss.send(QUEUES.processOrder, job, { singletonKey: webhookId });
console.log(`order ${payload.name} enqueued (idempotency key ${webhookId})`);

await boss.stop({ graceful: false });
await pool.end();
