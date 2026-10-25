import { sql } from "drizzle-orm";
import { chaosSettings, stock } from "./schema/erp.ts";
import { createDb, requireDatabaseUrl } from "./client.ts";

const CATALOG = [
  ["LV-SCARF-001", "Printed silk scarf", 24],
  ["LV-SCARF-002", "Cashmere stole", 12],
  ["CL-BAG-100", "Grained leather tote bag", 8],
  ["CL-BAG-101", "Smooth leather clutch", 15],
  ["DR-PARF-050", "Eau de parfum 50 ml", 60],
  ["DR-PARF-100", "Eau de parfum 100 ml", 34],
  ["GU-CREAM-030", "Day cream 30 ml", 45],
  ["GU-CREAM-050", "Night cream 50 ml", 22],
  ["CA-WATCH-001", "Steel watch, leather strap", 3],
  ["CA-WATCH-002", "Rose gold watch", 1],
  ["TF-RING-004", "Sterling silver ring", 18],
  ["TF-RING-005", "Set white gold ring", 2],
  ["RW-LUGG-055", "Aluminium cabin suitcase", 6],
  ["RW-LUGG-075", "Aluminium checked suitcase", 4],
  ["CLR-SERUM-030", "Radiance serum 30 ml", 40],
  ["CLR-MASK-075", "Hydrating mask 75 ml", 28],
  ["GV-SHOE-041", "Black leather derby, size 41", 5],
  ["GV-SHOE-042", "Black leather derby, size 42", 7],
  ["PK-GIFT-BOX", "Engraved gift box", 100],
  ["PK-GIFT-CARD", "Paper gift card", 500],
] as const;

export async function seed(connectionString = requireDatabaseUrl()) {
  const { db, pool } = createDb(connectionString, 1);
  try {
    await db
      .insert(stock)
      .values(CATALOG.map(([sku, title, quantity]) => ({ sku, title, quantity })))
      .onConflictDoUpdate({
        target: stock.sku,
        set: { title: sql`excluded.title`, updatedAt: new Date() },
      });

    await db.insert(chaosSettings).values({ id: 1 }).onConflictDoNothing();
    return CATALOG.length;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = await seed();
  console.log(`seed: ${count} SKUs in stock, chaos mode initialized`);
}
