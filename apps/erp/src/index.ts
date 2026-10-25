import { serve } from "@hono/node-server";
import { createDb } from "@sync/db";
import { createErpApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { logger } from "./lib/logger.ts";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const app = createErpApp({ db, env });

const server = serve({ fetch: app.fetch, port: env.ERP_PORT }, (info) => {
  logger.info({ port: info.port }, "erp.started");
});

/** Graceful shutdown: stop accepting connections, let in-flight requests finish. */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown.requested");
    server.close(async () => {
      await pool.end();
      logger.info("shutdown.completed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("shutdown.forced_after_10s");
      process.exit(1);
    }, 10_000).unref();
  });
}
