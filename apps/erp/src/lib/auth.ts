import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "@sync/db";
import { account, session, user, verification } from "@sync/db/schema";
import type { Env } from "../env.ts";

/**
 * Better Auth instead of home-made password hashing.
 *
 * What the library handles for us: password hashing (scrypt), sessions stored
 * in the database, httpOnly + Secure + SameSite cookie, login attempt
 * limiting. Public sign-up is disabled: both accounts (admin and demo) come
 * from the seed script.
 *
 * None of this on the Shopify app side: its authentication is handled by
 * Shopify (session tokens, token exchange).
 */
export function createAuth(db: Database, env: Env, opts: { allowSignUp?: boolean } = {}) {
  return betterAuth({
    appName: "mini-ERP",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
      usePlural: false,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !opts.allowSignUp,
      minPasswordLength: 12,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "demo",
          input: false, // never set from an incoming request
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
      customRules: {
        // Login attempt limiting.
        "/sign-in/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "erp",
      useSecureCookies: env.NODE_ENV === "production",
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    },
    trustedOrigins: [env.BETTER_AUTH_URL],
  });
}

export type Auth = ReturnType<typeof createAuth>;
