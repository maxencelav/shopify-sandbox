import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { erpOrders, stock } from "../../../packages/db/src/schema/erp.ts";
import {
  openDb,
  orderPayload,
  resetDatabase,
  seedStock,
  testEnv,
  TEST_ENV,
} from "../../../test/support/harness.ts";
import { createErpApp } from "../src/app.ts";
import { databaseUrl } from "../../../test/support/harness.ts";
import { setChaos } from "../src/lib/chaos.ts";

const { db, close } = openDb();
const env = testEnv(databaseUrl());
const app = createErpApp({ db, env });

const headers = (key: string) => ({
  "Content-Type": "application/json",
  "X-Api-Key": TEST_ENV.ERP_API_KEY!,
  "Idempotency-Key": key,
});

beforeEach(async () => {
  await resetDatabase(db);
  await seedStock(db, [{ sku: "SKU-A", quantity: 5 }, { sku: "SKU-RARE", quantity: 1 }]);
});

afterAll(close);

describe("POST /api/v1/orders — idempotency", () => {
  it("creates the order only once when the same key is replayed", async () => {
    const body = JSON.stringify(orderPayload());

    const first = await app.request("/api/v1/orders", { method: "POST", headers: headers("evt-1"), body });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };

    const second = await app.request("/api/v1/orders", { method: "POST", headers: headers("evt-1"), body });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    const replayed = (await second.json()) as { id: string };

    // Same ERP ID replayed, and a single row in the database.
    expect(replayed.id).toBe(created.id);
    const rows = await db.select().from(erpOrders);
    expect(rows).toHaveLength(1);

    // Stock was decremented only once.
    const [sku] = await db.select().from(stock).where(eq(stock.sku, "SKU-A"));
    expect(sku?.quantity).toBe(4);
  });

  it("rejects the same key with a different body (422)", async () => {
    await app.request("/api/v1/orders", {
      method: "POST",
      headers: headers("evt-2"),
      body: JSON.stringify(orderPayload()),
    });

    const conflicting = await app.request("/api/v1/orders", {
      method: "POST",
      headers: headers("evt-2"),
      body: JSON.stringify(orderPayload({ externalReference: "#9999" })),
    });

    expect(conflicting.status).toBe(422);
    const error = (await conflicting.json()) as { code: string; retryable: boolean };
    expect(error.code).toBe("idempotency_key_reused");
    expect(error.retryable).toBe(false);
  });

  it("requires the Idempotency-Key header", async () => {
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": TEST_ENV.ERP_API_KEY! },
      body: JSON.stringify(orderPayload()),
    });
    expect(response.status).toBe(400);
  });

  it("creates no duplicate when the response is lost and the request replayed", async () => {
    // Chaos mode set to always lose the response: the ERP stores the order,
    // the client receives nothing.
    await setChaos(db, { enabled: 1, failureRate: 0, lostResponseRate: 100, throttleRate: 0, latencyMs: 0 });
    const body = JSON.stringify(orderPayload({ externalReference: "#1002" }));

    const lost = await app.request("/api/v1/orders", { method: "POST", headers: headers("evt-3"), body });
    expect(lost.status).toBe(503);
    expect(await db.select().from(erpOrders)).toHaveLength(1);

    // The worker retries with the same key: it gets the stored response.
    await setChaos(db, { enabled: 0 });
    const retry = await app.request("/api/v1/orders", { method: "POST", headers: headers("evt-3"), body });
    expect(retry.status).toBe(200);
    expect(await db.select().from(erpOrders)).toHaveLength(1);
  });

  it("rejects a request without an API key (401)", async () => {
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "evt-4" },
      body: JSON.stringify(orderPayload()),
    });
    expect(response.status).toBe(401);
  });
});
