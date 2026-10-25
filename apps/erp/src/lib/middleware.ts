import { randomUUID, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Database } from "@sync/db";
import type { RequestOutcome, UserRole } from "@sync/db/schema";
import type { Auth } from "./auth.ts";
import { forbidden, unauthorized } from "./errors.ts";
import { logger } from "./logger.ts";

export type AppBindings = {
  Variables: {
    db: Database;
    auth: Auth;
    requestId: string;
    role?: UserRole;
    userEmail?: string;
    /** Outcome set by the handler for the request log. */
    outcome?: RequestOutcome;
  };
};

/**
 * Correlation: the app sends an X-Request-Id, the ERP reuses it in its logs
 * and echoes it in the response. An incident can be traced end to end.
 */
export const requestContext = createMiddleware<AppBindings>(async (c, next) => {
  const requestId = c.req.header("X-Request-Id") ?? randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  const started = Date.now();
  await next();
  logger.info(
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
    },
    "request.completed",
  );
});

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * API access (app -> ERP): key in X-Api-Key, compared in constant time.
 * Machine clients always get the admin role: they are systems, not humans
 * whose data needs masking.
 */
export const apiKeyAuth = (expected: string) =>
  createMiddleware<AppBindings>(async (c, next) => {
    const provided = c.req.header("X-Api-Key");
    if (!provided || !safeEqual(provided, expected)) throw unauthorized();
    c.set("role", "admin");
    await next();
  });

/** UI access (humans): cookie session, managed by Better Auth. */
export const sessionAuth = (opts: { require: boolean } = { require: true }) =>
  createMiddleware<AppBindings>(async (c, next) => {
    const auth = c.get("auth");
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!result?.user) {
      if (opts.require) throw unauthorized("Session required");
      return next();
    }
    c.set("role", (result.user as { role?: UserRole }).role ?? "demo");
    c.set("userEmail", result.user.email);
    await next();
  });

export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get("role") !== "admin") throw forbidden();
  await next();
});

/**
 * CSRF on UI POST forms: double-submit token (cookie + hidden field),
 * compared in constant time. Hono caches the body, so the handler can read
 * the form again after this middleware.
 */
export const csrfProtect = createMiddleware<AppBindings>(async (c, next) => {
  const cookieToken = getCookie(c, "erp.csrf");
  const form = await c.req.formData();
  const formToken = String(form.get("_csrf") ?? "");
  if (!cookieToken || !formToken || !safeEqual(cookieToken, formToken)) {
    throw forbidden("Invalid CSRF token");
  }
  await next();
});
