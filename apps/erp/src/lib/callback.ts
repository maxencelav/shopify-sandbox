import { createHmac } from "node:crypto";
import { logger } from "./logger.ts";

/**
 * Signed ERP -> app callback, modeled on Shopify webhooks:
 * raw body + base64 HMAC-SHA256 in a header.
 */
export function signPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export type ShipmentCallback = {
  event: "order.shipped";
  erpOrderId: string;
  externalReference: string;
  trackingNumber: string | null;
  occurredAt: string;
};

export async function sendShipmentCallback(
  url: string | undefined,
  secret: string,
  payload: ShipmentCallback,
  requestId: string,
): Promise<{ delivered: boolean; status?: number; error?: string }> {
  if (!url) return { delivered: false, error: "APP_CALLBACK_URL not configured" };
  const raw = JSON.stringify(payload);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Erp-Hmac-Sha256": signPayload(raw, secret),
        "X-Erp-Event": payload.event,
        "X-Request-Id": requestId,
      },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { delivered: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { delivered: true, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ requestId, err: message }, "callback.not_delivered");
    return { delivered: false, error: message };
  }
}
