import { sql } from "drizzle-orm";
import type { Database } from "@sync/db";
import { stock } from "@sync/db/schema";
import type { StockImportInput } from "./validation.ts";

/**
 * Catalog import from Shopify: unknown SKUs are created with the default
 * quantity, known SKUs only get their title refreshed. Quantities are never
 * overwritten: the ERP is the stock master, Shopify only names the products.
 *
 * Replaying the same import leaves the table unchanged, so no idempotency key
 * is needed.
 */
export async function importStock(
  db: Database,
  input: StockImportInput,
): Promise<{ created: number; updated: number }> {
  const rows = await db
    .insert(stock)
    .values(
      dedupeBySku(input.items).map((item) => ({
        sku: item.sku,
        title: item.title,
        quantity: input.defaultQuantity,
      })),
    )
    .onConflictDoUpdate({
      target: stock.sku,
      set: { title: sql`excluded.title`, updatedAt: new Date() },
    })
    // xmax is 0 on a freshly inserted row and non-zero on an updated one:
    // a single round trip tells created and updated rows apart.
    .returning({ created: sql<boolean>`xmax = 0` });

  const created = rows.filter((r) => r.created).length;
  return { created, updated: rows.length - created };
}

/** Postgres rejects an upsert that touches the same row twice in one statement. */
function dedupeBySku<T extends { sku: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.sku, item])).values()];
}
