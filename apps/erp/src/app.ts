import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Database } from "@sync/db";
import type { Env } from "./env.ts";
import { createAuth } from "./lib/auth.ts";
import { ErpError } from "./lib/errors.ts";
import { logger } from "./lib/logger.ts";
import { apiKeyAuth, requestContext, type AppBindings } from "./lib/middleware.ts";
import { recordRequest } from "./lib/request-log.ts";
import { apiRoutes } from "./routes/api.ts";
import { uiRoutes } from "./routes/ui.tsx";

export function createErpApp({ db, env }: { db: Database; env: Env }) {
  const auth = createAuth(db, env);
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("auth", auth);
    await next();
  });
  app.use("*", requestContext);

  /** Healthcheck: actually queries the database, otherwise it is useless. */
  app.get("/health", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok", database: "up" });
    } catch {
      return c.json({ status: "degraded", database: "down" }, 503);
    }
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Machine access (app/worker -> ERP): API key.
  // Logged before authentication, so a wrong API key shows up too.
  app.use("/api/v1/*", recordRequest);
  app.use("/api/v1/*", apiKeyAuth(env.ERP_API_KEY));
  app.route("/api/v1", apiRoutes(env));

  // Human access: cookie session.
  app.route("/", uiRoutes(env));

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ErpError) {
      logger.warn({ requestId, code: err.code, status: err.status }, err.message);
      return c.json(err.toBody(), err.status as 400, err.headers);
    }
    logger.error({ requestId, err }, "request.unhandled_error");
    return c.json(
      { code: "internal_error", message: "Internal error", retryable: true },
      500,
    );
  });

  app.notFound((c) =>
    c.json({ code: "not_found", message: "Unknown route", retryable: false }, 404),
  );

  return app;
}
