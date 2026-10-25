import { desc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Database } from "@sync/db";
import { requestLog, type RequestLogEntry, type RequestOutcome } from "@sync/db/schema";
import { logger } from "./logger.ts";
import type { AppBindings } from "./middleware.ts";

/** Without a hint from the handler, the outcome is derived from the HTTP status. */
function outcomeFromStatus(status: number): RequestOutcome {
  if (status < 400) return "ok";
  if (status === 503) return "unavailable";
  if (status === 429) return "throttled";
  if (status < 500) return "rejected";
  return "error";
}

/**
 * Logs every machine call on /api/v1, once the response is known.
 *
 * The handler can set the outcome (`c.set("outcome", …)`) when the HTTP status
 * is not enough: a 200 can be a replay, a 503 a lost response.
 * Writing the log never fails the request.
 */
export const recordRequest = createMiddleware<AppBindings>(async (c, next) => {
  const started = Date.now();
  await next();

  const status = c.res.status;
  const errorCode =
    status >= 400
      ? await c.res
          .clone()
          .json()
          .then((body: { code?: unknown }) => (typeof body.code === "string" ? body.code : null))
          .catch(() => null)
      : null;

  await c
    .get("db")
    .insert(requestLog)
    .values({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status,
      outcome: c.get("outcome") ?? outcomeFromStatus(status),
      idempotencyKey: c.req.header("Idempotency-Key") ?? null,
      errorCode,
      durationMs: Date.now() - started,
    })
    .catch((err: unknown) => {
      logger.warn({ requestId: c.get("requestId"), err }, "request_log.write_failed");
    });
});

export async function listRequestLog(
  db: Database,
  opts: { limit?: number; idempotencyKey?: string } = {},
): Promise<RequestLogEntry[]> {
  const query = db.select().from(requestLog);
  const filtered = opts.idempotencyKey
    ? query.where(eq(requestLog.idempotencyKey, opts.idempotencyKey))
    : query;
  return filtered.orderBy(desc(requestLog.id)).limit(opts.limit ?? 100);
}
