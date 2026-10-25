import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { QUEUES } from "@sync/worker";
import { db, getBoss } from "../db.server.ts";
import { ingestOrderWebhook, type ShopifyOrderWebhook } from "../lib/ingest.server.ts";
import { authenticate } from "../shopify.server.ts";

/**
 * orders/create webhook receiver.
 *
 * Order of operations, which is the whole point:
 *
 * 1. `authenticate.webhook` checks the HMAC signature of the raw body. An
 *    invalid signature throws, and Shopify gets a 401.
 * 2. The event is inserted with ON CONFLICT DO NOTHING on the webhook ID
 *    (X-Shopify-Webhook-Id header). Shopify delivers "at least once": the
 *    duplicate is ignored here, a single row in the database.
 * 3. The job is enqueued and we answer 200 right away. Shopify expects a
 *    response within 5 seconds, otherwise it considers the delivery failed
 *    and retries — any heavy work must go through the queue.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);

  const result = await ingestOrderWebhook(db, {
    webhookId,
    shop,
    topic,
    payload: payload as ShopifyOrderWebhook,
    requestId: request.headers.get("X-Request-Id") ?? randomUUID(),
  });

  if (result.status === "duplicate") {
    return new Response(null, { status: 200, headers: { "X-Duplicate": "true" } });
  }

  const boss = await getBoss();
  // singletonKey: even if the enqueue were replayed, only one job is queued.
  await boss.send(QUEUES.processOrder, result.job, { singletonKey: webhookId });

  return new Response(null, { status: 200 });
};
