import { PgBoss } from "pg-boss";

export const QUEUES = {
  processOrder: "process-order",
  processOrderDead: "process-order-dead",
  reconcile: "reconcile-orders",
} as const;

export type ProcessOrderJob = {
  shop: string;
  shopifyOrderId: string;
  shopifyOrderGid: string;
  shopifyOrderName: string | null;
  /** Stable key sent to the ERP: one order = one key, however many retries. */
  idempotencyKey: string;
  reason: "webhook" | "reconcile" | "manual";
  requestId: string;
};

export type ReconcileJob = { shop: string; lookbackHours: number };

/**
 * pg-boss rather than BullMQ: the queue lives in the Postgres we already have,
 * so no Redis to host, and enqueuing can take part in the application
 * transaction. The throughput needed here (a few orders per second) is far
 * below its limits.
 */
export async function createQueue(connectionString: string) {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    // Queue state monitoring, for metrics.
    monitorIntervalSeconds: 30,
  });

  boss.on("error", (error: unknown) => {
    console.error("pg-boss error", error);
  });

  await boss.start();

  await boss.createQueue(QUEUES.processOrderDead);
  await boss.createQueue(QUEUES.processOrder, {
    policy: "standard",
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true, // 5s, 10s, 20s, 40s, 80s
    expireInSeconds: 120,
    deadLetter: QUEUES.processOrderDead,
  });
  await boss.createQueue(QUEUES.reconcile, {
    policy: "singleton", // one reconciliation at a time
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 900,
  });

  return boss;
}

/** Nightly reconciliation: 3 a.m., server time. */
export async function scheduleNightlyReconcile(boss: PgBoss, shop: string) {
  await boss.schedule(QUEUES.reconcile, "0 3 * * *", { shop, lookbackHours: 24 }, { tz: "Europe/Paris" });
}
