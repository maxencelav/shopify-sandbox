/**
 * Admin API access token for the worker.
 *
 * Two sources, in order of preference:
 * - SHOPIFY_ADMIN_TOKEN: a static token (legacy custom app created in the admin);
 * - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET: an app from the Dev Dashboard,
 *   installed on a store of the same organization. The token comes from the
 *   client credentials grant and expires after about 24 hours, so it is cached
 *   and fetched again shortly before it expires.
 */
import type { WorkerEnv } from "../env.ts";

export type TokenProvider = () => Promise<string>;

/** Refresh this long before the announced expiry, to absorb clock skew. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export function clientCredentialsToken(opts: {
  shop: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): TokenProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await doFetch(`https://${opts.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // The body may echo request details: keep only the status.
      throw new Error(`Shopify token exchange failed with ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Shopify token exchange returned no access_token");
    cached = {
      token: body.access_token,
      expiresAt: now() + (body.expires_in ?? 86_400) * 1000 - REFRESH_MARGIN_MS,
    };
    return body.access_token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    // Concurrent jobs share one exchange instead of each requesting a token.
    pending ??= fetchToken().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Builds the token source from the environment, or undefined when none is set. */
export function adminTokenFromEnv(
  env: Pick<
    WorkerEnv,
    "SHOPIFY_SHOP" | "SHOPIFY_ADMIN_TOKEN" | "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET"
  >,
): { shop: string; accessToken: string | TokenProvider } | undefined {
  if (!env.SHOPIFY_SHOP) return undefined;
  if (env.SHOPIFY_ADMIN_TOKEN) {
    return { shop: env.SHOPIFY_SHOP, accessToken: env.SHOPIFY_ADMIN_TOKEN };
  }
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
    return {
      shop: env.SHOPIFY_SHOP,
      accessToken: clientCredentialsToken({
        shop: env.SHOPIFY_SHOP,
        clientId: env.SHOPIFY_CLIENT_ID,
        clientSecret: env.SHOPIFY_CLIENT_SECRET,
      }),
    };
  }
  return undefined;
}
