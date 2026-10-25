import { describe, expect, it } from "vitest";
import { createErpClient, ErpRequestError } from "../src/lib/erp-client.ts";

function clientReturning(response: Response) {
  return createErpClient({
    baseUrl: "http://erp.test",
    apiKey: "cle-de-test",
    fetchImpl: async () => response,
  });
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const payload = {
  externalReference: "#1",
  customer: { name: "A", email: "a@example.com" },
  lines: [{ sku: "SKU-A", quantity: 1, unitPrice: "10.00" }],
  currency: "EUR",
};

describe("createErpClient — retry decision", () => {
  it("trusts the body retryable field, not the HTTP status alone", async () => {
    const client = clientReturning(
      json({ code: "out_of_stock", message: "rupture", retryable: false }, 409),
    );
    await expect(client.createOrder(payload, "k1")).rejects.toMatchObject({
      code: "out_of_stock",
      retryable: false,
    });
  });

  it("reads Retry-After on a 429", async () => {
    const client = clientReturning(
      json({ code: "rate_limited", message: "stop", retryable: true }, 429, { "Retry-After": "12" }),
    );
    await expect(client.createOrder(payload, "k2")).rejects.toMatchObject({
      retryable: true,
      opts: { retryAfterSeconds: 12 },
    });
  });

  it("treats a network error as temporary", async () => {
    const client = createErpClient({
      baseUrl: "http://erp.test",
      apiKey: "cle-de-test",
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    const error = await client.createOrder(payload, "k3").catch((e) => e);
    expect(error).toBeInstanceOf(ErpRequestError);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("network_error");
  });

  it("falls back to the HTTP status when the body is unusable", async () => {
    const client = clientReturning(new Response("Bad Gateway", { status: 502 }));
    await expect(client.createOrder(payload, "k4")).rejects.toMatchObject({ retryable: true });
  });

  it("sends the idempotency key and the API key", async () => {
    let seen: Headers | undefined;
    const client = createErpClient({
      baseUrl: "http://erp.test",
      apiKey: "cle-de-test",
      fetchImpl: async (_input, init) => {
        seen = new Headers(init?.headers as HeadersInit);
        return json({ id: "ERP-1", externalReference: "#1", status: "received", total: "10.00", currency: "EUR" }, 201);
      },
    });

    await client.createOrder(payload, "cle-idem-42", "req-7");
    expect(seen?.get("Idempotency-Key")).toBe("cle-idem-42");
    expect(seen?.get("X-Api-Key")).toBe("cle-de-test");
    expect(seen?.get("X-Request-Id")).toBe("req-7");
  });
});
