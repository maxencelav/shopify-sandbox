import { createDb } from "@sync/db";
import { loadEnv } from "./env.ts";
import { createErpClient } from "./lib/erp-client.ts";
import { logger } from "./lib/logger.ts";
import { createAdminClient } from "./lib/shopify-admin.ts";
import { adminTokenFromEnv } from "./lib/shopify-token.ts";
import { processOrder } from "./jobs/process-order.ts";
import { reconcileOrders } from "./jobs/reconcile.ts";
import { QUEUES, createQueue, scheduleNightlyReconcile, type ProcessOrderJob, type ReconcileJob } from "./queue.ts";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const erp = createErpClient({ baseUrl: env.ERP_BASE_URL, apiKey: env.ERP_API_KEY });
const adminAccess = adminTokenFromEnv(env);
const admin = adminAccess ? createAdminClient(adminAccess) : undefined;

if (!admin) {
  logger.warn(
    "SHOPIFY_SHOP with SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID/SECRET missing: metafield writes and reconciliation disabled",
  );
}

const boss = await createQueue(env.DATABASE_URL);

await boss.work<ProcessOrderJob>(
  QUEUES.processOrder,
  { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true },
  async ([job]) => {
    if (!job) return;
    const outcome = await processOrder({ db, erp, boss, admin }, job.data);
    logger.debug({ jobId: job.id, outcome }, "job.processed");
  },
);

await boss.work<ProcessOrderJob & { reasonCode?: string }>(
  QUEUES.processOrderDead,
  { batchSize: 10 },
  async (jobs) => {
    for (const job of jobs) {
      logger.error(
        { shopifyOrderId: job.data.shopifyOrderId, code: job.data.reasonCode },
        "order.dead_lettered",
      );
    }
  },
);

if (admin) {
  await boss.work<ReconcileJob>(QUEUES.reconcile, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await reconcileOrders({ db, boss, admin: admin }, job.data);
  });
  if (env.SHOPIFY_SHOP) await scheduleNightlyReconcile(boss, env.SHOPIFY_SHOP);
}

logger.info({ concurrency: env.WORKER_CONCURRENCY }, "worker.started");

/**
 * Graceful shutdown: let pg-boss finish in-flight jobs (otherwise they would
 * be retried for nothing) before closing the pool.
 */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown.requested");
    const forced = setTimeout(() => {
      logger.error("shutdown.forced_after_15s");
      process.exit(1);
    }, 15_000);
    forced.unref();
    try {
      await boss.stop({ graceful: true, timeout: 12_000 });
      await pool.end();
      logger.info("shutdown.completed");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "shutdown.failed");
      process.exit(1);
    }
  });
}
