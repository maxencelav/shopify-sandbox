import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ERP_BASE_URL: z.string().url().default("http://localhost:8787"),
  ERP_API_KEY: z.string().min(8),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SHOPIFY_SHOP: z.string().optional(),
  // Either a static Admin API token, or a Dev Dashboard app's credentials.
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`);
    throw new Error(`Invalid worker configuration:\n${details.join("\n")}`);
  }
  return parsed.data;
}
