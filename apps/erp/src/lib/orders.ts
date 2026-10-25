import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@sync/db";
import { erpOrders, stock, type ErpOrder, type ErpOrderLine } from "@sync/db/schema";
import { badRequest, notFound, outOfStock, unprocessable } from "./errors.ts";
import type { CreateOrderInput } from "./validation.ts";

/**
 * Order creation: the order insert and the stock decrement happen in the
 * SAME transaction, with a lock on each stock row (SELECT ... FOR UPDATE).
 * Two concurrent orders on the last item cannot both succeed: the second one
 * sees 0 and gets a 409.
 */
export async function createOrder(db: Database, input: CreateOrderInput): Promise<ErpOrder> {
  const merged = mergeLines(input.lines);
  return db.transaction(async (tx) => {
    for (const line of merged) {
      const [row] = await tx
        .select({ sku: stock.sku, quantity: stock.quantity })
        .from(stock)
        .where(eq(stock.sku, line.sku))
        .for("update")
        .limit(1);
      if (!row) throw unprocessable(`Unknown SKU: ${line.sku}`, { sku: line.sku });
      if (row.quantity < line.quantity) {
        throw outOfStock(line.sku, row.quantity, line.quantity);
      }
      await tx
        .update(stock)
        .set({ quantity: sql`${stock.quantity} - ${line.quantity}`, updatedAt: new Date() })
        .where(eq(stock.sku, line.sku));
    }

    const [created] = await tx
      .insert(erpOrders)
      .values({
        id: `ERP-${randomUUID().slice(0, 8).toUpperCase()}`,
        externalReference: input.externalReference,
        customer: input.customer,
        lines: input.lines,
        total: computeTotal(input.lines),
        currency: input.currency,
      })
      .returning();
    if (!created) throw badRequest("Order could not be created");
    return created;
  });
}

/** Cancellation: stock is restored. Idempotent on an already cancelled order. */
export async function cancelOrder(db: Database, id: string): Promise<ErpOrder> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(erpOrders)
      .where(eq(erpOrders.id, id))
      .for("update")
      .limit(1);
    if (!order) throw notFound(`Order ${id} not found`);
    if (order.status === "cancelled") return order;
    if (order.status === "shipped") {
      throw unprocessable("A shipped order can no longer be cancelled", { id });
    }

    for (const line of mergeLines(order.lines)) {
      await tx
        .update(stock)
        .set({ quantity: sql`${stock.quantity} + ${line.quantity}`, updatedAt: new Date() })
        .where(eq(stock.sku, line.sku));
    }

    const [updated] = await tx
      .update(erpOrders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(erpOrders.id, id))
      .returning();
    return updated ?? order;
  });
}

export async function shipOrder(
  db: Database,
  id: string,
  trackingNumber: string | null,
): Promise<ErpOrder> {
  const [order] = await db.select().from(erpOrders).where(eq(erpOrders.id, id)).limit(1);
  if (!order) throw notFound(`Order ${id} not found`);
  if (order.status === "cancelled") {
    throw unprocessable("A cancelled order cannot be shipped", { id });
  }
  const [updated] = await db
    .update(erpOrders)
    .set({ status: "shipped", trackingNumber, updatedAt: new Date() })
    .where(eq(erpOrders.id, id))
    .returning();
  return updated ?? order;
}

export async function listOrders(
  db: Database,
  opts: { limit?: number; externalReference?: string } = {},
): Promise<ErpOrder[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where = opts.externalReference
    ? and(eq(erpOrders.externalReference, opts.externalReference))
    : undefined;
  return db
    .select()
    .from(erpOrders)
    .where(where)
    .orderBy(desc(erpOrders.createdAt))
    .limit(limit);
}

export async function getOrder(db: Database, id: string): Promise<ErpOrder> {
  const [order] = await db.select().from(erpOrders).where(eq(erpOrders.id, id)).limit(1);
  if (!order) throw notFound(`Order ${id} not found`);
  return order;
}

export async function listStock(db: Database) {
  return db.select().from(stock).orderBy(stock.sku);
}

function mergeLines(lines: ErpOrderLine[]): { sku: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  }
  return [...totals].map(([sku, quantity]) => ({ sku, quantity }));
}

export function computeTotal(lines: ErpOrderLine[]): string {
  const cents = lines.reduce(
    (sum, line) => sum + Math.round(Number(line.unitPrice) * 100) * line.quantity,
    0,
  );
  return (cents / 100).toFixed(2);
}
