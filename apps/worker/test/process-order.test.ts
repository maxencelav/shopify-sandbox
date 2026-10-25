import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { ordersSummary, webhookEvents } from "../../../packages/db/src/schema/app.ts";
import { erpOrders } from "../../../packages/db/src/schema/erp.ts";
import {
  databaseUrl,
  openDb,
  resetDatabase,
  seedStock,
  testEnv,
  TEST_ENV,
} from "../../../test/support/harness.ts";
import { createErpApp } from "../../erp/src/app.ts";
import { setChaos } from "../../erp/src/lib/chaos.ts";
import { createErpClient } from "../src/lib/erp-client.ts";
import { processOrder } from "../src/jobs/process-order.ts";
import { QUEUES, type ProcessOrderJob } from "../src/queue.ts";

const { db, close } = openDb();
const env = testEnv(databaseUrl());
const erpApp = createErpApp({ db, env });

/**
 * The worker talks to the real ERP (same Hono app, same Postgres): the full
 * chain is tested without an HTTP server, by wiring `fetchImpl` to `app.fetch`.
 */
function clientAgainstErp(failTimes = 0) {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    if (calls <= failTimes) {
      throw new Error("connection refused (simulated outage)");
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return erpApp.fetch(new Request(url, init as RequestInit));
  };
  return {
    client: createErpClient({
      baseUrl: "http://erp.test",
      apiKey: TEST_ENV.ERP_API_KEY!,
      fetchImpl,
    }),
    get calls() {
      return calls;
    },
  };
}

function fakeBoss() {
  const sent: { queue: string; data: unknown; options?: unknown }[] = [];
  const boss = {
    send: vi.fn(async (queue: string, data: unknown, options?: unknown) => {
      sent.push({ queue, data, options });
      return "job-id";
    }),
  } as unknown as PgBoss;
  return { boss, sent };
}

async function arrangeOrder(opts: {
  webhookId: string;
  orderId: string;
  lines: { sku: string; quantity: number; price: string }[];
}): Promise<ProcessOrderJob> {
  await db.insert(webhookEvents).values({
    shopifyWebhookId: opts.webhookId,
    shop: "demo.myshopify.com",
    topic: "orders/create",
    payload: {
      id: Number(opts.orderId),
      name: `#${opts.orderId}`,
      currency: "EUR",
      customer: { first_name: "Marie", last_name: "Dupont", email: "marie@example.com" },
      shipping_address: { city: "Paris", zip: "75002", country: "France" },
      line_items: opts.lines.map((l, i) => ({
        id: i + 1,
        sku: l.sku,
        title: l.sku,
        quantity: l.quantity,
        price: l.price,
      })),
    },
  });

  await db.insert(ordersSummary).values({
    shop: "demo.myshopify.com",
    shopifyOrderId: opts.orderId,
    shopifyOrderName: `#${opts.orderId}`,
    idempotencyKey: opts.webhookId,
    status: "pending",
  });

  return {
    shop: "demo.myshopify.com",
    shopifyOrderId: opts.orderId,
    shopifyOrderGid: `gid://shopify/Order/${opts.orderId}`,
    shopifyOrderName: `#${opts.orderId}`,
    idempotencyKey: opts.webhookId,
    reason: "webhook",
    requestId: `req-${opts.orderId}`,
  };
}

beforeEach(async () => {
  await resetDatabase(db);
  await seedStock(db, [{ sku: "SKU-A", quantity: 5 }, { sku: "SKU-RARE", quantity: 1 }]);
});

afterAll(close);

describe("processOrder", () => {
  it("syncs the order and stores the ERP ID", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-1",
      orderId: "5001",
      lines: [{ sku: "SKU-A", quantity: 2, price: "120.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();

    const outcome = await processOrder({ db, erp: client, boss }, job);

    expect(outcome.result).toBe("synced");
    const [summary] = await db
      .select()
      .from(ordersSummary)
      .where(eq(ordersSummary.shopifyOrderId, "5001"));
    expect(summary?.status).toBe("synced");
    expect(summary?.externalOrderId).toMatch(/^ERP-/);
    expect(summary?.syncedAt).toBeInstanceOf(Date);
    expect(await db.select().from(erpOrders)).toHaveLength(1);
  });

  it("rethrows on a temporary error so pg-boss applies its backoff", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-2",
      orderId: "5002",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const failing = clientAgainstErp(1);
    const { boss } = fakeBoss();

    await expect(processOrder({ db, erp: failing.client, boss }, job)).rejects.toThrow(
      /unreachable/,
    );
    const [failed] = await db
      .select()
      .from(ordersSummary)
      .where(eq(ordersSummary.shopifyOrderId, "5002"));
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);

    // Second pass (what pg-boss does): the same key succeeds.
    const outcome = await processOrder({ db, erp: failing.client, boss }, job);
    expect(outcome.result).toBe("synced");
    expect(await db.select().from(erpOrders)).toHaveLength(1);
  });

  it("dead-letters on a permanent error, without retrying", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-3",
      orderId: "5003",
      lines: [{ sku: "SKU-RARE", quantity: 2, price: "900.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss, sent } = fakeBoss();

    const outcome = await processOrder({ db, erp: client, boss }, job);

    expect(outcome).toEqual({ result: "dead", code: "out_of_stock" });
    const [summary] = await db
      .select()
      .from(ordersSummary)
      .where(eq(ordersSummary.shopifyOrderId, "5003"));
    expect(summary?.status).toBe("dead");
    expect(summary?.lastError).toContain("out_of_stock");
    expect(sent.map((s) => s.queue)).toEqual([QUEUES.processOrderDead]);
  });

  it("names a variant without a SKU explicitly instead of failing validation", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-nosku",
      orderId: "5010",
      lines: [{ sku: "", quantity: 1, price: "50.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();

    const outcome = await processOrder({ db, erp: client, boss }, job);

    expect(outcome).toEqual({ result: "dead", code: "unprocessable_entity" });
    const [summary] = await db
      .select()
      .from(ordersSummary)
      .where(eq(ordersSummary.shopifyOrderId, "5010"));
    expect(summary?.lastError).toContain("Unknown SKU: UNKNOWN-1");
  });

  it("does nothing when the order is already synced", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-4",
      orderId: "5004",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();

    await processOrder({ db, erp: client, boss }, job);
    const second = await processOrder({ db, erp: client, boss }, job);

    expect(second.result).toBe("already_synced");
    expect(await db.select().from(erpOrders)).toHaveLength(1);
  });

  it("creates no duplicate when the ERP response is lost and the job replayed", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-5",
      orderId: "5005",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();

    await setChaos(db, { enabled: 1, failureRate: 0, lostResponseRate: 100, throttleRate: 0, latencyMs: 0 });
    await expect(processOrder({ db, erp: client, boss }, job)).rejects.toThrow();
    // The ERP did store the order, despite the failure on the worker side.
    expect(await db.select().from(erpOrders)).toHaveLength(1);

    await setChaos(db, { enabled: 0 });
    const outcome = await processOrder({ db, erp: client, boss }, job);
    expect(outcome.result).toBe("synced");
    expect(await db.select().from(erpOrders)).toHaveLength(1);
  });

  it("honors Retry-After on a 429 by rescheduling the job", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-6",
      orderId: "5006",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const { boss, sent } = fakeBoss();
    const throttling = createErpClient({
      baseUrl: "http://erp.test",
      apiKey: TEST_ENV.ERP_API_KEY!,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "rate_limited", message: "Too many requests", retryable: true }),
          { status: 429, headers: { "Retry-After": "7", "Content-Type": "application/json" } },
        ),
    });

    const outcome = await processOrder({ db, erp: throttling, boss }, job);

    expect(outcome).toEqual({ result: "retry_scheduled", afterSeconds: 7 });
    expect(sent[0]?.queue).toBe(QUEUES.processOrder);
    expect(sent[0]?.options).toEqual({ startAfter: 7 });
  });

  it("writes the Shopify metafields after a successful sync", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-7",
      orderId: "5007",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();
    const writeSyncMetafields = vi.fn(async () => {});

    await processOrder(
      { db, erp: client, boss, admin: { writeSyncMetafields } as never },
      job,
    );

    expect(writeSyncMetafields).toHaveBeenCalledWith(
      "gid://shopify/Order/5007",
      expect.stringMatching(/^ERP-/),
      expect.any(Date),
    );
  });

  it("does not fail the sync when the metafield write fails", async () => {
    const job = await arrangeOrder({
      webhookId: "wh-8",
      orderId: "5008",
      lines: [{ sku: "SKU-A", quantity: 1, price: "120.00" }],
    });
    const { client } = clientAgainstErp();
    const { boss } = fakeBoss();

    const outcome = await processOrder(
      {
        db,
        erp: client,
        boss,
        admin: {
          writeSyncMetafields: async () => {
            throw new Error("metafield rejected");
          },
        } as never,
      },
      job,
    );

    expect(outcome.result).toBe("synced");
  });
});
