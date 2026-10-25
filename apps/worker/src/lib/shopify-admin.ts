/**
 * Minimal Admin GraphQL client, worker side.
 *
 * The Shopify app uses the official template's client (authenticated with a
 * session token). The worker runs outside any request: it uses either a static
 * Admin API token or one from the client credentials grant (see shopify-token.ts).
 *
 * Two points that matter:
 * - throttling is read from `extensions.cost.throttleStatus` (remaining point
 *   budget), not only from a 429;
 * - a mutation's user errors come back in `userErrors` with an HTTP 200: they
 *   must be checked explicitly.
 */

import type { TokenProvider } from "./shopify-token.ts";

const API_VERSION = "2026-01";

export class ShopifyGraphQLError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyGraphQLError";
  }
}

export type ThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};

export function createAdminClient(opts: {
  shop: string;
  accessToken: string | TokenProvider;
  fetchImpl?: typeof fetch;
}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = `https://${opts.shop}/admin/api/${API_VERSION}/graphql.json`;
  let lastThrottle: ThrottleStatus | undefined;

  async function query<T>(
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const accessToken =
      typeof opts.accessToken === "string" ? opts.accessToken : await opts.accessToken();
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 429) {
      throw new ShopifyGraphQLError("Admin API throttled", true);
    }
    if (!response.ok) {
      throw new ShopifyGraphQLError(
        `Admin API responded with ${response.status}`,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
      extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
    };

    const throttle = payload.extensions?.cost?.throttleStatus;
    if (throttle) lastThrottle = throttle;

    if (payload.errors?.length) {
      const throttled = payload.errors.some((e) => e.extensions?.code === "THROTTLED");
      throw new ShopifyGraphQLError(
        payload.errors.map((e) => e.message).join(" | "),
        throttled,
        payload.errors,
      );
    }
    if (!payload.data) throw new ShopifyGraphQLError("Empty Admin API response", true);
    return payload.data;
  }

  /** Waits when the remaining point budget gets too low. */
  async function waitForBudget(needed = 100): Promise<void> {
    if (!lastThrottle) return;
    const missing = needed - lastThrottle.currentlyAvailable;
    if (missing <= 0) return;
    const waitMs = Math.ceil((missing / lastThrottle.restoreRate) * 1000);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 10_000)));
  }

  const METAFIELDS_SET = `
    mutation SetSyncMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key namespace value }
        userErrors { field message code }
      }
    }`;

  const RECENT_ORDERS = `
    query RecentOrders($cursor: String, $query: String!) {
      orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { id name createdAt displayFulfillmentStatus }
      }
    }`;

  const PRODUCT_VARIANTS = `
    query ProductVariants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku title product { title } }
      }
    }`;

  return {
    get throttleStatus() {
      return lastThrottle;
    },
    waitForBudget,

    /** Writes the external ID and the sync date on the order. */
    async writeSyncMetafields(orderGid: string, erpOrderId: string, syncedAt: Date) {
      const data = await query<{
        metafieldsSet: { userErrors: { field: string[]; message: string }[] };
      }>(METAFIELDS_SET, {
        metafields: [
          {
            ownerId: orderGid,
            namespace: "erp_sync",
            key: "external_order_id",
            type: "single_line_text_field",
            value: erpOrderId,
          },
          {
            ownerId: orderGid,
            namespace: "erp_sync",
            key: "synced_at",
            type: "date_time",
            value: syncedAt.toISOString(),
          },
        ],
      });
      const userErrors = data.metafieldsSet.userErrors;
      if (userErrors.length) {
        // Validation errors: permanent, retrying would change nothing.
        throw new ShopifyGraphQLError(
          userErrors.map((e) => `${e.field?.join(".")}: ${e.message}`).join(" | "),
          false,
          userErrors,
        );
      }
    },

    /** Cursor pagination over recent orders (nightly reconciliation). */
    async *iterateRecentOrders(since: Date) {
      let cursor: string | null = null;
      const search = `created_at:>'${since.toISOString()}'`;
      do {
        await waitForBudget();
        const data: {
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { id: string; name: string; createdAt: string }[];
          };
        } = await query(RECENT_ORDERS, { cursor, query: search });
        yield* data.orders.nodes;
        cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      } while (cursor);
    },

    /** Cursor pagination over every product variant (catalog import). */
    async *iterateProductVariants() {
      let cursor: string | null = null;
      do {
        // A 250-variant page costs about 250 points: wait for that much budget.
        await waitForBudget(300);
        const data: {
          productVariants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: ShopifyVariant[];
          };
        } = await query(PRODUCT_VARIANTS, { cursor });
        yield* data.productVariants.nodes;
        cursor = data.productVariants.pageInfo.hasNextPage
          ? data.productVariants.pageInfo.endCursor
          : null;
      } while (cursor);
    },
  };
}

export type ShopifyVariant = {
  id: string;
  sku: string | null;
  title: string;
  product: { title: string };
};

export type AdminClient = ReturnType<typeof createAdminClient>;
