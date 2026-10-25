import { z } from "zod";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "amount expected in the 12.34 format");

export const orderLineSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(999),
  unitPrice: money,
  title: z.string().max(200).optional(),
  /** Engraving, gift message: Shopify cart line item properties. */
  properties: z.record(z.string(), z.string().max(500)).optional(),
});

export const customerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: z.string().max(40).optional(),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      city: z.string().max(120).optional(),
      postalCode: z.string().max(20).optional(),
      country: z.string().max(80).optional(),
    })
    .optional(),
});

export const createOrderSchema = z.object({
  externalReference: z.string().min(1).max(120),
  customer: customerSchema,
  lines: z.array(orderLineSchema).min(1).max(100),
  currency: z.string().length(3).default("EUR"),
});

export const shipOrderSchema = z.object({
  trackingNumber: z.string().min(1).max(120).nullable().default(null),
});

export const chaosPatchSchema = z.object({
  enabled: z.coerce.boolean().optional(),
  failureRate: z.coerce.number().int().min(0).max(100).optional(),
  latencyMs: z.coerce.number().int().min(0).max(10_000).optional(),
  lostResponseRate: z.coerce.number().int().min(0).max(100).optional(),
  throttleRate: z.coerce.number().int().min(0).max(100).optional(),
});

/** Catalog import: SKUs and titles only, the ERP stays the stock master. */
export const stockImportSchema = z.object({
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), title: z.string().min(1).max(200) }))
    .min(1)
    .max(500),
  /** Quantity given to SKUs the ERP has never seen. */
  defaultQuantity: z.number().int().min(0).max(100_000).default(10),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ShipOrderInput = z.infer<typeof shipOrderSchema>;
export type StockImportInput = z.infer<typeof stockImportSchema>;
