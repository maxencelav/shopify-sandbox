import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { desc, eq } from "drizzle-orm";
import { ordersSummary, type SyncStatus } from "@sync/db/schema";
import { db } from "../db.server.ts";
import { authenticate } from "../shopify.server.ts";
import { requeueOrder } from "../lib/requeue.server.ts";

type Row = {
  shopifyOrderId: string;
  name: string | null;
  status: SyncStatus;
  attempts: number;
  externalOrderId: string | null;
  syncedAt: string | null;
  lastError: string | null;
  total: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const rows = await db
    .select()
    .from(ordersSummary)
    .where(eq(ordersSummary.shop, session.shop))
    .orderBy(desc(ordersSummary.updatedAt))
    .limit(100);

  const counts = rows.reduce<Record<SyncStatus, number>>(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    { pending: 0, synced: 0, failed: 0, dead: 0 },
  );

  return {
    counts,
    orders: rows.map<Row>((row) => ({
      shopifyOrderId: row.shopifyOrderId,
      name: row.shopifyOrderName,
      status: row.status,
      attempts: row.attempts,
      externalOrderId: row.externalOrderId,
      syncedAt: row.syncedAt?.toISOString() ?? null,
      lastError: row.lastError,
      total: row.totalPrice,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const orderId = String(form.get("shopifyOrderId") ?? "");
  if (!orderId) return { ok: false, message: "Missing order" };
  // Retrying is safe: the idempotency key is the same, the ERP will not
  // create a second record.
  const ok = await requeueOrder(session.shop, orderId);
  return { ok, message: ok ? "Order requeued" : "Order not found" };
};

const TONE: Record<SyncStatus, "success" | "attention" | "critical" | "info"> = {
  synced: "success",
  pending: "info",
  failed: "attention",
  dead: "critical",
};

const LABEL: Record<SyncStatus, string> = {
  synced: "synced",
  pending: "pending",
  failed: "failed",
  dead: "dead-lettered",
};

export default function Index() {
  const { orders, counts } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const rows = orders.map((order) => [
    order.name ?? order.shopifyOrderId,
    <Badge key={`${order.shopifyOrderId}-status`} tone={TONE[order.status]}>
      {LABEL[order.status]}
    </Badge>,
    order.externalOrderId ?? "—",
    String(order.attempts),
    order.syncedAt ? new Date(order.syncedAt).toLocaleString("en-GB") : "—",
    order.lastError ? (
      <Text key={`${order.shopifyOrderId}-err`} as="span" tone="critical" truncate>
        {order.lastError}
      </Text>
    ) : (
      "—"
    ),
    order.status === "synced" ? (
      "—"
    ) : (
      <Form key={`${order.shopifyOrderId}-form`} method="post">
        <input type="hidden" name="shopifyOrderId" value={order.shopifyOrderId} />
        <Button submit variant="secondary" size="slim" loading={busy}>
          Retry
        </Button>
      </Form>
    ),
  ]);

  return (
    <Page
      title="ERP sync"
      subtitle="Delivery status of orders sent to the ERP"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200">
                <Badge tone="success">{`${counts.synced} synced`}</Badge>
                <Badge tone="info">{`${counts.pending} pending`}</Badge>
                <Badge tone="attention">{`${counts.failed} failed`}</Badge>
                <Badge tone="critical">{`${counts.dead} dead-lettered`}</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Failed orders are retried automatically with an increasing delay.
                "Dead-lettered" means a permanent error (out of stock, unknown SKU) that
                needs a human decision.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {orders.length === 0 ? (
              <EmptyState
                heading="No orders processed yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Place a test order on the dev store, or trigger the webhook with{" "}
                  <code>shopify app webhook trigger</code>.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                headings={[
                  "Order",
                  "Status",
                  "ERP ID",
                  "Attempts",
                  "Synced at",
                  "Last error",
                  "",
                ]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
