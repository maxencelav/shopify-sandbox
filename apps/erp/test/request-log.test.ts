import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { requestLog } from "../../../packages/db/src/schema/erp.ts";
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
import { setChaos } from "../src/lib/chaos.ts";

const { db, close } = openDb();
const env = testEnv(databaseUrl());
const app = createErpApp({ db, env });

const headers = (key: string) => ({
  "Content-Type": "application/json",
  "X-Api-Key": TEST_ENV.ERP_API_KEY!,
  "Idempotency-Key": key,
});

const post = (key: string, body = JSON.stringify(orderPayload())) =>
  app.request("/api/v1/orders", { method: "POST", headers: headers(key), body });

const readLog = () => db.select().from(requestLog).orderBy(asc(requestLog.id));

beforeEach(async () => {
  await resetDatabase(db);
  await seedStock(db, [{ sku: "SKU-A", quantity: 5 }]);
});

afterAll(close);

describe("machine request log", () => {
  it("records a creation then a replay under the same key", async () => {
    await post("evt-log-1");
    await post("evt-log-1");

    const rows = await readLog();
    expect(rows.map((r) => [r.status, r.outcome, r.idempotencyKey])).toEqual([
      [201, "created", "evt-log-1"],
      [200, "replayed", "evt-log-1"],
    ]);
  });

  it("tells a lost response apart from a real outage", async () => {
    await setChaos(db, { enabled: 1, failureRate: 0, lostResponseRate: 100, throttleRate: 0, latencyMs: 0 });
    await post("evt-log-2");
    await setChaos(db, { enabled: 1, failureRate: 100, lostResponseRate: 0, throttleRate: 0, latencyMs: 0 });
    await post("evt-log-3");

    const rows = await readLog();
    expect(rows.map((r) => [r.status, r.outcome, r.errorCode])).toEqual([
      [503, "lost_response", "lost_response"],
      [503, "unavailable", "service_unavailable"],
    ]);
  });

  it("records a business error and an invalid API key", async () => {
    await post("evt-log-4", JSON.stringify(orderPayload({ lines: [{ sku: "SKU-A", quantity: 99, unitPrice: "1.00" }] })));
    await app.request("/api/v1/orders", {
      method: "POST",
      headers: { ...headers("evt-log-5"), "X-Api-Key": "wrong-key" },
      body: JSON.stringify(orderPayload()),
    });

    const rows = await readLog();
    expect(rows.map((r) => [r.status, r.outcome, r.errorCode])).toEqual([
      [409, "rejected", "out_of_stock"],
      [401, "rejected", "unauthorized"],
    ]);
  });

  it("contains no customer data", async () => {
    await post("evt-log-6");
    const serialized = JSON.stringify(await readLog());
    const { customer } = orderPayload();
    for (const value of [customer.name, customer.email, customer.phone!]) {
      expect(serialized).not.toContain(value);
    }
  });
});
