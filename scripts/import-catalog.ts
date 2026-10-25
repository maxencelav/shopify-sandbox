/**
 * Imports the Shopify store catalog into the ERP stock.
 *
 *   npm run catalog:import                   # new SKUs get 10 units
 *   npm run catalog:import -- --quantity 50  # new SKUs get 50 units
 *
 * Needs SHOPIFY_SHOP plus SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID/SECRET
 * (read_products scope), and the ERP running. Existing ERP quantities are
 * never overwritten.
 */
import { loadEnv } from "../apps/worker/src/env.ts";
import { importCatalog } from "../apps/worker/src/jobs/import-catalog.ts";
import { createErpClient } from "../apps/worker/src/lib/erp-client.ts";
import { createAdminClient } from "../apps/worker/src/lib/shopify-admin.ts";
import { adminTokenFromEnv } from "../apps/worker/src/lib/shopify-token.ts";

const env = loadEnv();
const adminAccess = adminTokenFromEnv(env);
if (!adminAccess) {
  console.error(
    "Set SHOPIFY_SHOP plus SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, in .env",
  );
  process.exit(1);
}

const quantityFlag = process.argv.indexOf("--quantity");
const defaultQuantity = quantityFlag === -1 ? 10 : Number(process.argv[quantityFlag + 1]);
if (!Number.isInteger(defaultQuantity) || defaultQuantity < 0) {
  console.error("--quantity expects a positive integer");
  process.exit(1);
}

const summary = await importCatalog(
  {
    admin: createAdminClient(adminAccess),
    erp: createErpClient({ baseUrl: env.ERP_BASE_URL, apiKey: env.ERP_API_KEY }),
  },
  { defaultQuantity },
);

console.log(
  `${summary.variants} variants read: ${summary.created} SKUs created, ${summary.updated} updated`,
);
if (summary.withoutSku.length) {
  console.warn(
    `${summary.withoutSku.length} variants without a SKU (their orders will be dead-lettered):`,
  );
  for (const title of summary.withoutSku) console.warn(`  - ${title}`);
}
if (summary.duplicateSkus.length) {
  console.warn(`SKUs shared by several variants, first one kept: ${summary.duplicateSkus.join(", ")}`);
}
