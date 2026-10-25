import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { stock } from "../../../packages/db/src/schema/erp.ts";
import {
  databaseUrl,
  openDb,
  resetDatabase,
  seedStock,
  testEnv,
  TEST_ENV,
} from "../../../test/support/harness.ts";
import { createErpApp } from "../../erp/src/app.ts";
import { importCatalog } from "../src/jobs/import-catalog.ts";
import { createErpClient } from "../src/lib/erp-client.ts";
import type { AdminClient, ShopifyVariant } from "../src/lib/shopify-admin.ts";

const { db, close } = openDb();
const erpApp = createErpApp({ db, env: testEnv(databaseUrl()) });

const erp = createErpClient({
  baseUrl: "http://erp.test",
  apiKey: TEST_ENV.ERP_API_KEY!,
  fetchImpl: async (input, init) => erpApp.fetch(new Request(String(input), init as RequestInit)),
});

function fakeAdmin(variants: ShopifyVariant[]): AdminClient {
  return {
    async *iterateProductVariants() {
      yield* variants;
    },
  } as unknown as AdminClient;
}

const variant = (sku: string | null, product: string, title = "Default Title"): ShopifyVariant => ({
  id: `gid://shopify/ProductVariant/${product}-${title}`,
  sku,
  title,
  product: { title: product },
});

const quantityOf = async (sku: string) =>
  (await db.select().from(stock).where(eq(stock.sku, sku)))[0]?.quantity;

beforeEach(() => resetDatabase(db));
afterAll(close);

describe("catalog import", () => {
  it("creates unknown SKUs with the default quantity and readable titles", async () => {
    const summary = await importCatalog(
      {
        admin: fakeAdmin([
          variant("SCARF-1", "Silk scarf"),
          variant("SHOE-41", "Derby", "41"),
          variant("SHOE-42", "Derby", "42"),
        ]),
        erp,
      },
      { defaultQuantity: 7 },
    );

    expect(summary).toMatchObject({ variants: 3, created: 3, updated: 0 });
    const rows = await db.select().from(stock).orderBy(stock.sku);
    expect(rows.map((r) => [r.sku, r.title, r.quantity])).toEqual([
      ["SCARF-1", "Silk scarf", 7],
      ["SHOE-41", "Derby / 41", 7],
      ["SHOE-42", "Derby / 42", 7],
    ]);
  });

  it("never overwrites the quantity of a SKU the ERP already knows", async () => {
    await seedStock(db, [{ sku: "SCARF-1", quantity: 2, title: "Old title" }]);

    const summary = await importCatalog(
      { admin: fakeAdmin([variant("SCARF-1", "Silk scarf")]), erp },
      { defaultQuantity: 50 },
    );

    expect(summary).toMatchObject({ created: 0, updated: 1 });
    const [row] = await db.select().from(stock).where(eq(stock.sku, "SCARF-1"));
    expect(row).toMatchObject({ title: "Silk scarf", quantity: 2 });
  });

  it("is safe to run twice", async () => {
    const admin = fakeAdmin([variant("SCARF-1", "Silk scarf")]);
    await importCatalog({ admin, erp }, { defaultQuantity: 5 });
    const second = await importCatalog({ admin, erp }, { defaultQuantity: 5 });

    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(await quantityOf("SCARF-1")).toBe(5);
  });

  it("reports variants without a SKU and duplicate SKUs instead of importing them", async () => {
    const summary = await importCatalog(
      {
        admin: fakeAdmin([
          variant("", "Gift card"),
          variant(null, "Tote bag", "Black"),
          variant("RING-1", "Silver ring"),
          variant("RING-1", "Gold ring"),
        ]),
        erp,
      },
      { defaultQuantity: 3 },
    );

    expect(summary).toMatchObject({
      variants: 4,
      created: 1,
      withoutSku: ["Gift card", "Tote bag / Black"],
      duplicateSkus: ["RING-1"],
    });
    const [row] = await db.select().from(stock).where(eq(stock.sku, "RING-1"));
    expect(row?.title).toBe("Silver ring");
  });

  it("sends large catalogs in several batches", async () => {
    const variants = Array.from({ length: 600 }, (_, i) => variant(`SKU-${i}`, `Product ${i}`));
    const summary = await importCatalog({ admin: fakeAdmin(variants), erp }, { defaultQuantity: 1 });

    expect(summary).toMatchObject({ variants: 600, created: 600 });
    expect(await db.$count(stock)).toBe(600);
  });
});
