import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { ordersSummary } from "../../../packages/db/src/schema/app.ts";
import { openDb, resetDatabase } from "../../../test/support/harness.ts";
import { gidToId, reconcileOrders } from "../src/jobs/reconcile.ts";
import { QUEUES, type ProcessOrderJob } from "../src/queue.ts";
import type { AdminClient } from "../src/lib/shopify-admin.ts";

const { db, close } = openDb();
const SHOP = "demo.myshopify.com";

function fakeAdmin(orders: { id: string; name: string }[]): AdminClient {
  return {
    async *iterateRecentOrders() {
      for (const order of orders) yield { ...order, createdAt: new Date().toISOString() };
    },
    waitForBudget: async () => {},
    throttleStatus: undefined,
    writeSyncMetafields: async () => {},
  } as unknown as AdminClient;
}

function fakeBoss() {
  const sent: { queue: string; data: ProcessOrderJob }[] = [];
  const boss = {
    send: vi.fn(async (queue: string, data: ProcessOrderJob) => {
      sent.push({ queue, data });
      return "job-id";
    }),
  } as unknown as PgBoss;
  return { boss, sent };
}

beforeEach(() => resetDatabase(db));
afterAll(close);

describe("nightly reconciliation", () => {
  it("requeues orders whose webhook never arrived", async () => {
    // 6001 was processed, 6002 left no trace: lost webhook.
    await db.insert(ordersSummary).values({
      shop: SHOP,
      shopifyOrderId: "6001",
      idempotencyKey: "wh-6001",
      status: "synced",
      externalOrderId: "ERP-AAAA",
      syncedAt: new Date(),
    });

    const { boss, sent } = fakeBoss();
    const result = await reconcileOrders(
      {
        db,
        boss,
        admin: fakeAdmin([
          { id: "gid://shopify/Order/6001", name: "#6001" },
          { id: "gid://shopify/Order/6002", name: "#6002" },
        ]),
      },
      { shop: SHOP, lookbackHours: 24 },
    );

    expect(result).toEqual({ scanned: 2, requeued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe(QUEUES.processOrder);
    expect(sent[0]?.data.shopifyOrderId).toBe("6002");
    expect(sent[0]?.data.reason).toBe("reconcile");

    const rows = await db.select().from(ordersSummary);
    expect(rows).toHaveLength(2);
  });

  it("creates no duplicate when run twice in a row", async () => {
    const { boss, sent } = fakeBoss();
    const admin = fakeAdmin([{ id: "gid://shopify/Order/6003", name: "#6003" }]);

    await reconcileOrders({ db, boss, admin }, { shop: SHOP, lookbackHours: 24 });
    await reconcileOrders({ db, boss, admin }, { shop: SHOP, lookbackHours: 24 });

    // Two enqueues (the job stays idempotent on the ERP side), but a single row.
    expect(sent).toHaveLength(2);
    expect(await db.select().from(ordersSummary)).toHaveLength(1);
  });

  it("skips dead-lettered orders, which need a human decision", async () => {
    await db.insert(ordersSummary).values({
      shop: SHOP,
      shopifyOrderId: "6004",
      idempotencyKey: "wh-6004",
      status: "dead",
      lastError: "out_of_stock",
    });

    const { boss, sent } = fakeBoss();
    const result = await reconcileOrders(
      { db, boss, admin: fakeAdmin([{ id: "gid://shopify/Order/6004", name: "#6004" }]) },
      { shop: SHOP, lookbackHours: 24 },
    );

    expect(result.requeued).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("extracts the numeric ID from a Shopify GID", () => {
    expect(gidToId("gid://shopify/Order/123456")).toBe("123456");
    expect(gidToId("123456")).toBe("123456");
  });
});
