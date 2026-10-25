import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { ordersSummary } from "@sync/db/schema";
import { db } from "../db.server.ts";
import { unauthenticated } from "../shopify.server.ts";

/**
 * ERP callback when an order moves to "shipped".
 *
 * Same protocol as Shopify webhooks: HMAC-SHA256 of the raw body, base64,
 * compared in constant time. Sync in both directions: the app then writes a
 * status metafield on the order.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.ERP_CALLBACK_SECRET;
  if (!secret) return new Response("ERP_CALLBACK_SECRET is missing", { status: 500 });

  const raw = await request.text();
  const provided = request.headers.get("X-Erp-Hmac-Sha256") ?? "";
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  if (!safeEqual(provided, expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(raw) as {
    event: string;
    erpOrderId: string;
    externalReference: string;
    trackingNumber: string | null;
    occurredAt: string;
  };
  if (payload.event !== "order.shipped") return new Response(null, { status: 204 });

  const [summary] = await db
    .select()
    .from(ordersSummary)
    .where(
      and(
        eq(ordersSummary.externalOrderId, payload.erpOrderId),
      ),
    )
    .limit(1);
  if (!summary) return new Response("Unknown order", { status: 404 });

  const { admin } = await unauthenticated.admin(summary.shop);
  await admin.graphql(
    `#graphql
      mutation SetFulfillmentStatus($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: `gid://shopify/Order/${summary.shopifyOrderId}`,
            namespace: "erp_sync",
            key: "erp_status",
            type: "single_line_text_field",
            value: payload.trackingNumber ? `shipped:${payload.trackingNumber}` : "shipped",
          },
        ],
      },
    },
  );

  return new Response(null, { status: 200 });
};

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
