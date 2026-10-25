import { eq } from "drizzle-orm";
import { createDb } from "@sync/db";
import { user } from "@sync/db/schema";
import { loadEnv } from "./env.ts";
import { createAuth } from "./lib/auth.ts";

/**
 * Creates the two UI accounts. Public sign-up is disabled in the app: this
 * script uses a Better Auth instance that allows it.
 */
async function main() {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL, 1);
  const auth = createAuth(db, env, { allowSignUp: true });

  const accounts = [
    {
      email: required("ERP_ADMIN_EMAIL"),
      password: required("ERP_ADMIN_PASSWORD"),
      name: "Admin ERP",
      role: "admin" as const,
    },
    {
      email: required("ERP_DEMO_EMAIL"),
      password: required("ERP_DEMO_PASSWORD"),
      name: "Demo account",
      role: "demo" as const,
    },
  ];

  try {
    for (const acc of accounts) {
      const [existing] = await db.select().from(user).where(eq(user.email, acc.email)).limit(1);
      if (existing) {
        await db.update(user).set({ role: acc.role }).where(eq(user.id, existing.id));
        console.log(`account updated: ${acc.email} (${acc.role})`);
        continue;
      }
      await auth.api.signUpEmail({
        body: { email: acc.email, password: acc.password, name: acc.name },
      });
      await db.update(user).set({ role: acc.role }).where(eq(user.email, acc.email));
      console.log(`account created: ${acc.email} (${acc.role})`);
    }
  } finally {
    await pool.end();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from the environment`);
  return value;
}

await main();
