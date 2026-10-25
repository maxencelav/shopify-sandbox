import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { erpOrders, stock } from "../../../packages/db/src/schema/erp.ts";
import {
  databaseUrl,
  openDb,
  orderPayload,
  resetDatabase,
  seedStock,
  testEnv,
  TEST_ENV,
} from "../../../test/support/harness.ts";
import { createErpApp } from "../src/app.ts";

const { db, close } = openDb();
const app = createErpApp({ db, env: testEnv(databaseUrl()) });

const headers = (key: string) => ({
  "Content-Type": "application/json",
  "X-Api-Key": TEST_ENV.ERP_API_KEY!,
  "Idempotency-Key": key,
});

beforeEach(async () => {
  await resetDatabase(db);
  await seedStock(db, [{ sku: "SKU-A", quantity: 3 }, { sku: "SKU-RARE", quantity: 1 }]);
});

afterAll(close);

describe("stock and transactions", () => {
  it("returns a permanent error when out of stock", async () => {
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: headers("evt-oos"),
      body: JSON.stringify(
        orderPayload({ lines: [{ sku: "SKU-RARE", quantity: 2, unitPrice: "900.00" }] }),
      ),
    });

    expect(response.status).toBe(409);
    const error = (await response.json()) as { code: string; retryable: boolean };
    expect(error.code).toBe("out_of_stock");
    // Permanent: the worker must not retry, it goes to the dead-letter queue.
    expect(error.retryable).toBe(false);

    // The transaction was rolled back: nothing created, stock untouched.
    expect(await db.select().from(erpOrders)).toHaveLength(0);
    const [sku] = await db.select().from(stock).where(eq(stock.sku, "SKU-RARE"));
    expect(sku?.quantity).toBe(1);
  });

  it("lets only one order through on the last item, even concurrently", async () => {
    const body = (ref: string) =>
      JSON.stringify(orderPayload({
        externalReference: ref,
        lines: [{ sku: "SKU-RARE", quantity: 1, unitPrice: "900.00" }],
      }));

    const [a, b] = await Promise.all([
      app.request("/api/v1/orders", { method: "POST", headers: headers("evt-c1"), body: body("#A") }),
      app.request("/api/v1/orders", { method: "POST", headers: headers("evt-c2"), body: body("#B") }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await db.select().from(erpOrders)).toHaveLength(1);
    const [sku] = await db.select().from(stock).where(eq(stock.sku, "SKU-RARE"));
    expect(sku?.quantity).toBe(0);
  });

  it("restores stock when the order is cancelled", async () => {
    const created = await app.request("/api/v1/orders", {
      method: "POST",
      headers: headers("evt-cancel"),
      body: JSON.stringify(orderPayload({ lines: [{ sku: "SKU-A", quantity: 2, unitPrice: "120.00" }] })),
    });
    const order = (await created.json()) as { id: string };

    const cancelled = await app.request(`/api/v1/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { "X-Api-Key": TEST_ENV.ERP_API_KEY! },
    });
    expect(cancelled.status).toBe(200);

    const [sku] = await db.select().from(stock).where(eq(stock.sku, "SKU-A"));
    expect(sku?.quantity).toBe(3);

    // Cancelling twice does not restore the stock twice.
    await app.request(`/api/v1/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { "X-Api-Key": TEST_ENV.ERP_API_KEY! },
    });
    const [again] = await db.select().from(stock).where(eq(stock.sku, "SKU-A"));
    expect(again?.quantity).toBe(3);
  });

  it("rejects an unknown SKU (422, permanent)", async () => {
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: headers("evt-unknown"),
      body: JSON.stringify(orderPayload({ lines: [{ sku: "NOPE", quantity: 1, unitPrice: "10.00" }] })),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { retryable: boolean }).retryable).toBe(false);
  });
});
