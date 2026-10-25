import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { user } from "../../../packages/db/src/schema/auth.ts";
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
import { createAuth } from "../src/lib/auth.ts";
import { pseudonymize, serializeOrder } from "../src/lib/serialize.ts";
import { createOrder } from "../src/lib/orders.ts";

const { db, close } = openDb();
const env = testEnv(databaseUrl());
const app = createErpApp({ db, env });

/** Deliberately recognizable values: if one leaks, the test fails. */
const SECRETS = {
  name: "Marie Dupont",
  email: "marie.dupont@example.com",
  phone: "+33612345678",
  line1: "12 rue de la Paix",
};

beforeEach(async () => {
  await resetDatabase(db);
  await seedStock(db, [{ sku: "SKU-A", quantity: 10 }]);
});

afterAll(close);

async function signInAs(role: "admin" | "demo"): Promise<string> {
  const authWithSignUp = createAuth(db, env, { allowSignUp: true });
  const email = `${role}@example.com`;
  const password = "test-password-12345";
  await authWithSignUp.api.signUpEmail({ body: { email, password, name: role } });
  await db.update(user).set({ role }).where(eq(user.email, email));

  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get("set-cookie");
  expect(cookie, "sign-in failed").toBeTruthy();
  return cookie!.split(";")[0]!;
}

async function createRealOrder() {
  return createOrder(db, {
    externalReference: "#2001",
    customer: {
      name: SECRETS.name,
      email: SECRETS.email,
      phone: SECRETS.phone,
      address: { line1: SECRETS.line1, city: "Paris", postalCode: "75002", country: "France" },
    },
    lines: [{ sku: "SKU-A", quantity: 1, unitPrice: "120.00" }],
    currency: "EUR",
  });
}

describe("personal data masking (demo role)", () => {
  it("masks name, email, phone and address, keeps city and postal code", () => {
    const order = {
      id: "ERP-TEST",
      externalReference: "#2001",
      status: "received" as const,
      customer: {
        name: SECRETS.name,
        email: SECRETS.email,
        phone: SECRETS.phone,
        address: { line1: SECRETS.line1, city: "Paris", postalCode: "75002", country: "France" },
      },
      lines: [{ sku: "SKU-A", quantity: 1, unitPrice: "120.00" }],
      total: "120.00",
      currency: "EUR",
      trackingNumber: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const masked = serializeOrder(order, "demo", env.DEMO_PSEUDONYM_SECRET);
    expect(masked.customer.name).toBe("M. D.");
    expect(masked.customer.email).toBe("m***@***.com");
    expect(masked.customer.phone).toBe("••••••78");
    expect(masked.customer.city).toBe("Paris");
    expect(masked.customer.postalCode).toBe("75002");
    expect(masked.customer.masked).toBe(true);
    // The address line is never exposed, to any role.
    expect(JSON.stringify(masked)).not.toContain(SECRETS.line1);

    const full = serializeOrder(order, "admin", env.DEMO_PSEUDONYM_SECRET);
    expect(full.customer.email).toBe(SECRETS.email);
    expect(full.customer.masked).toBe(false);
  });

  it("gives a stable pseudonym, identical across orders from the same customer", () => {
    const a = pseudonymize(SECRETS.email, env.DEMO_PSEUDONYM_SECRET);
    const b = pseudonymize(" MARIE.DUPONT@example.com ", env.DEMO_PSEUDONYM_SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^client-[0-9a-f]{4}$/);
    // Another secret gives another pseudonym: nothing is guessable without it.
    expect(pseudonymize(SECRETS.email, "other-secret")).not.toBe(a);
  });

  it("leaks no real data in the dashboard response", async () => {
    await createRealOrder();
    const cookie = await signInAs("demo");

    const response = await app.request("/", { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();

    for (const [field, value] of Object.entries(SECRETS)) {
      expect(html, `${field} must not appear in the response`).not.toContain(value);
    }
    expect(html).toContain("Demo account: masked data");
    expect(html).toContain("M. D.");
  });

  it("shows real data to the admin role", async () => {
    await createRealOrder();
    const cookie = await signInAs("admin");

    const html = await (await app.request("/", { headers: { cookie } })).text();
    expect(html).toContain(SECRETS.email);
    expect(html).not.toContain("Demo account");
  });

  it("forbids admin-only actions to the demo role", async () => {
    const order = await createRealOrder();
    const cookie = await signInAs("demo");

    const html = await (await app.request("/", { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

    const body = new URLSearchParams({ _csrf: csrf });
    const cancel = await app.request(`/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(cancel.status).toBe(403);

    const chaos = await app.request("/chaos", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, enabled: "on" }),
    });
    expect(chaos.status).toBe(403);
  });

  it("rejects a form without a valid CSRF token", async () => {
    const cookie = await signInAs("admin");
    await app.request("/", { headers: { cookie } });

    const response = await app.request("/chaos", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: "bogus-token", enabled: "on" }),
    });
    expect(response.status).toBe(403);
  });

  it("redirects to the sign-in page without a session", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });
});
