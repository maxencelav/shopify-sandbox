import type { ErpClient } from "../lib/erp-client.ts";
import type { AdminClient, ShopifyVariant } from "../lib/shopify-admin.ts";

/** Stays well under the ERP limit of 500 items per import request. */
const BATCH_SIZE = 250;

export type CatalogImportSummary = {
  variants: number;
  created: number;
  updated: number;
  /** Variants the ERP cannot know about: their orders would be dead-lettered. */
  withoutSku: string[];
  /** SKUs shared by several variants: only the first one is kept. */
  duplicateSkus: string[];
};

/**
 * Imports the Shopify catalog into the ERP stock, so that real orders from
 * the store reference SKUs the ERP knows.
 *
 * Shopify names the products, the ERP owns the quantities: new SKUs get
 * `defaultQuantity`, existing ones keep their stock. Running it twice is safe.
 */
export async function importCatalog(
  deps: { admin: AdminClient; erp: ErpClient },
  opts: { defaultQuantity: number },
): Promise<CatalogImportSummary> {
  const summary: CatalogImportSummary = {
    variants: 0,
    created: 0,
    updated: 0,
    withoutSku: [],
    duplicateSkus: [],
  };
  const seen = new Set<string>();
  let batch: { sku: string; title: string }[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const result = await deps.erp.importStock(batch, opts.defaultQuantity);
    summary.created += result.created;
    summary.updated += result.updated;
    batch = [];
  };

  for await (const variant of deps.admin.iterateProductVariants()) {
    summary.variants += 1;
    const sku = variant.sku?.trim();
    if (!sku) {
      summary.withoutSku.push(variantTitle(variant));
      continue;
    }
    if (seen.has(sku)) {
      summary.duplicateSkus.push(sku);
      continue;
    }
    seen.add(sku);
    batch.push({ sku, title: variantTitle(variant) });
    if (batch.length === BATCH_SIZE) await flush();
  }
  await flush();

  return summary;
}

/** "Silk scarf" for a single-variant product, "Silk scarf / Blue" otherwise. */
export function variantTitle(variant: ShopifyVariant): string {
  return variant.title === "Default Title"
    ? variant.product.title
    : `${variant.product.title} / ${variant.title}`;
}
