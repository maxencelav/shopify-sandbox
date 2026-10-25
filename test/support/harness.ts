import { sql } from "drizzle-orm";
import { createDb, type Database } from "../../packages/db/src/client.ts";
import { chaosSettings, stock } from "../../packages/db/src/schema/erp.ts";
import { loadEnv, type Env } from "../../apps/erp/src/env.ts";

export const TEST_ENV: NodeJS.ProcessEnv = {
  ERP_API_KEY: "test-api-key-123456",
  ERP_CALLBACK_SECRET: "test-callback-secret",
  DEMO_PSEUDONYM_SECRET: "test-pseudonym-secret",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars",
  BETTER_AUTH_URL: "http://localhost:8787",
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
};

export function testEnv(databaseUrl: string): Env {
  return loadEnv({ ...TEST_ENV, DATABASE_URL: databaseUrl });
}

export function databaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is missing: the global setup did not run");
  return url;
}

export function openDb(): { db: Database; close: () => Promise<void> } {
  const { db, pool } = createDb(databaseUrl(), 5);
  return { db, close: () => pool.end() };
}

/** Clean slate between two tests, keeping the migrated schema. */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`
    truncate table
      erp.erp_orders,
      erp.idempotency_keys,
      erp.erp_webhook_deliveries,
      erp.request_log,
      erp.stock,
      erp.chaos_settings,
      erp."session",
      erp."account",
      erp."user",
      public.webhook_events,
      public.orders_summary
    restart identity cascade
  `);
  await db.insert(chaosSettings).values({ id: 1, enabled: 0 });
}

export async function seedStock(
  db: Database,
  rows: { sku: string; quantity: number; title?: string }[],
): Promise<void> {
  await db
    .insert(stock)
    .values(rows.map((r) => ({ sku: r.sku, title: r.title ?? r.sku, quantity: r.quantity })))
    .onConflictDoUpdate({ target: stock.sku, set: { quantity: sql`excluded.quantity` } });
}

export function orderPayload(overrides: Partial<OrderPayload> = {}): OrderPayload {
  return {
    externalReference: "#1001",
    customer: {
      name: "Marie Dupont",
      email: "marie.dupont@example.com",
      phone: "+33612345678",
      address: { line1: "12 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
    },
    lines: [{ sku: "SKU-A", quantity: 1, unitPrice: "120.00", title: "Silk scarf" }],
    currency: "EUR",
    ...overrides,
  };
}

export type OrderPayload = {
  externalReference: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
    address?: { line1?: string; city?: string; postalCode?: string; country?: string };
  };
  lines: { sku: string; quantity: number; unitPrice: string; title?: string }[];
  currency: string;
};
