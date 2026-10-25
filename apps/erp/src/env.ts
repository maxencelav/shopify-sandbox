import { z } from "zod";

/** Config validated at startup: a missing secret fails the boot, not the first request. */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ERP_PORT: z.coerce.number().int().positive().default(8787),
  ERP_API_KEY: z.string().min(8),
  ERP_CALLBACK_SECRET: z.string().min(8),
  APP_CALLBACK_URL: z.string().url().optional(),
  DEMO_PSEUDONYM_SECRET: z.string().min(8),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:8787"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")} : ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ERP configuration:\n${details}`);
  }
  return parsed.data;
}
