import { Hono } from "hono";
import { erpWebhookDeliveries } from "@sync/db/schema";
import { applyChaos, readChaos } from "../lib/chaos.ts";
import { badRequest, unprocessable } from "../lib/errors.ts";
import { findReplay, hashRequest, rememberResponse } from "../lib/idempotency.ts";
import { logger } from "../lib/logger.ts";
import type { AppBindings } from "../lib/middleware.ts";
import { cancelOrder, createOrder, getOrder, listOrders, listStock, shipOrder } from "../lib/orders.ts";
import { sendShipmentCallback } from "../lib/callback.ts";
import { serializeOrder } from "../lib/serialize.ts";
import { importStock } from "../lib/stock.ts";
import { createOrderSchema, shipOrderSchema, stockImportSchema } from "../lib/validation.ts";
import type { Env } from "../env.ts";

export function apiRoutes(env: Env) {
  const api = new Hono<AppBindings>();

  /**
   * Idempotent creation.
   *
   * 201 the first time, 200 and the same ERP ID when the key is replayed with
   * the same body, 422 when the key is replayed with a different body.
   */
  api.post("/orders", async (c) => {
    const db = c.get("db");
    const key = c.req.header("Idempotency-Key");
    if (!key) throw badRequest("Idempotency-Key header required");

    const raw = await c.req.json().catch(() => {
      throw badRequest("Invalid JSON body");
    });
    const parsed = createOrderSchema.safeParse(raw);
    if (!parsed.success) {
      throw unprocessable("Invalid order", parsed.error.issues);
    }

    const requestHash = hashRequest(parsed.data);
    const replay = await findReplay(db, key, requestHash);
    if (replay) {
      c.header("Idempotency-Replayed", "true");
      c.set("outcome", "replayed");
      return c.json(replay.body as object, 200);
    }

    const chaos = await applyChaos(await readChaos(db));

    const order = await createOrder(db, parsed.data);
    const body = serializeOrder(order, "admin", env.DEMO_PSEUDONYM_SECRET);
    await rememberResponse(db, key, requestHash, 201, body);

    if (chaos === "lost_response") {
      c.set("outcome", "lost_response");
      // The order is stored, but the client will receive nothing: drop the
      // connection. Only the idempotency key will prevent a duplicate on retry.
      logger.warn(
        { requestId: c.get("requestId"), erpOrderId: order.id },
        "chaos.lost_response",
      );
      const outgoing = (c.env as { outgoing?: { socket?: { destroy(): void } } } | undefined)
        ?.outgoing;
      if (outgoing?.socket) {
        outgoing.socket.destroy();
        return new Response(null, { status: 503 });
      }
      // Outside an HTTP server (tests): equivalent temporary response for the worker.
      return c.json(
        { code: "lost_response", message: "Lost response (chaos mode)", retryable: true },
        503,
      );
    }

    c.set("outcome", "created");
    return c.json(body, 201);
  });

  api.get("/orders", async (c) => {
    const db = c.get("db");
    const ref = c.req.query("externalReference");
    const limit = Number(c.req.query("limit") ?? 50);
    const orders = await listOrders(db, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(ref ? { externalReference: ref } : {}),
    });
    return c.json({
      orders: orders.map((o) => serializeOrder(o, "admin", env.DEMO_PSEUDONYM_SECRET)),
    });
  });

  api.get("/orders/:id", async (c) => {
    const order = await getOrder(c.get("db"), c.req.param("id"));
    return c.json(serializeOrder(order, "admin", env.DEMO_PSEUDONYM_SECRET));
  });

  api.post("/orders/:id/cancel", async (c) => {
    const order = await cancelOrder(c.get("db"), c.req.param("id"));
    return c.json(serializeOrder(order, "admin", env.DEMO_PSEUDONYM_SECRET));
  });

  /**
   * Shipment: the ERP then notifies the app with an HMAC-signed call, the same
   * way Shopify does with its webhooks. Sync in both directions.
   */
  api.post("/orders/:id/ship", async (c) => {
    const db = c.get("db");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = shipOrderSchema.safeParse(raw);
    if (!parsed.success) throw unprocessable("Invalid shipment", parsed.error.issues);

    const order = await shipOrder(db, c.req.param("id"), parsed.data.trackingNumber);
    const delivery = await sendShipmentCallback(
      env.APP_CALLBACK_URL,
      env.ERP_CALLBACK_SECRET,
      {
        event: "order.shipped",
        erpOrderId: order.id,
        externalReference: order.externalReference,
        trackingNumber: order.trackingNumber,
        occurredAt: new Date().toISOString(),
      },
      c.get("requestId"),
    );

    await db
      .insert(erpWebhookDeliveries)
      .values({
        orderId: order.id,
        event: "order.shipped",
        ...(delivery.status !== undefined ? { status: delivery.status } : {}),
        ...(delivery.error !== undefined ? { error: delivery.error } : {}),
      })
      .onConflictDoUpdate({
        target: [erpWebhookDeliveries.orderId, erpWebhookDeliveries.event],
        set: {
          status: delivery.status ?? null,
          error: delivery.error ?? null,
          createdAt: new Date(),
        },
      });

    return c.json({
      ...serializeOrder(order, "admin", env.DEMO_PSEUDONYM_SECRET),
      callbackDelivered: delivery.delivered,
    });
  });

  api.get("/stock", async (c) => c.json({ stock: await listStock(c.get("db")) }));

  api.post("/stock/import", async (c) => {
    const raw = await c.req.json().catch(() => {
      throw badRequest("Invalid JSON body");
    });
    const parsed = stockImportSchema.safeParse(raw);
    if (!parsed.success) throw unprocessable("Invalid stock import", parsed.error.issues);
    return c.json(await importStock(c.get("db"), parsed.data));
  });

  return api;
}
