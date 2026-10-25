import { randomUUID } from "node:crypto";
import type { ErpCustomer, ErpOrderLine } from "@sync/db/schema";

/**
 * ERP client.
 *
 * Turns the HTTP response into a decision for the worker: retry or not.
 * The source of truth is the `retryable` field of the error body; the HTTP
 * status is only a fallback when the body is unusable.
 */

export type CreateOrderPayload = {
  externalReference: string;
  customer: ErpCustomer;
  lines: ErpOrderLine[];
  currency: string;
};

export type ErpOrderResponse = {
  id: string;
  externalReference: string;
  status: string;
  total: string;
  currency: string;
};

export class ErpRequestError extends Error {
  constructor(
    message: string,
    readonly opts: {
      status?: number;
      code: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "ErpRequestError";
  }

  get retryable() {
    return this.opts.retryable;
  }
  get code() {
    return this.opts.code;
  }
  get retryAfterSeconds() {
    return this.opts.retryAfterSeconds;
  }
}

export type ErpClient = ReturnType<typeof createErpClient>;

export function createErpClient(opts: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function request<T>(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string; requestId: string },
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {
      "X-Api-Key": opts.apiKey,
      "X-Request-Id": init.requestId,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

    let response: Response;
    try {
      response = await doFetch(new URL(path, opts.baseUrl), {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Timeout, dropped connection, DNS: temporary by nature. It is also the
      // chaos mode "lost response" case — the order may already exist in the
      // ERP, hence the idempotency key on retry.
      const message = error instanceof Error ? error.message : String(error);
      throw new ErpRequestError(`ERP unreachable: ${message}`, {
        code: "network_error",
        retryable: true,
      });
    }

    const text = await response.text();
    const body = text ? (safeJson(text) as T) : (null as T);

    if (response.ok) return { status: response.status, body };

    const err = (body ?? {}) as { code?: string; message?: string; retryable?: boolean };
    const retryAfter = Number(response.headers.get("Retry-After") ?? "");
    throw new ErpRequestError(err.message ?? `ERP responded with ${response.status}`, {
      status: response.status,
      code: err.code ?? `http_${response.status}`,
      retryable: err.retryable ?? (response.status >= 500 || response.status === 429),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }

  return {
    /** Idempotent creation: the same `idempotencyKey` never creates two orders. */
    async createOrder(
      payload: CreateOrderPayload,
      idempotencyKey: string,
      requestId: string = randomUUID(),
    ) {
      return request<ErpOrderResponse>("/api/v1/orders", {
        method: "POST",
        body: payload,
        idempotencyKey,
        requestId,
      });
    },

    async importStock(
      items: { sku: string; title: string }[],
      defaultQuantity: number,
      requestId: string = randomUUID(),
    ) {
      const { body } = await request<{ created: number; updated: number }>(
        "/api/v1/stock/import",
        { method: "POST", body: { items, defaultQuantity }, requestId },
      );
      return body;
    },

    async findByReference(externalReference: string, requestId: string = randomUUID()) {
      const { body } = await request<{ orders: ErpOrderResponse[] }>(
        `/api/v1/orders?externalReference=${encodeURIComponent(externalReference)}`,
        { method: "GET", requestId },
      );
      return body?.orders?.[0] ?? null;
    },

    async health(requestId: string = randomUUID()) {
      return request<{ status: string }>("/health", { method: "GET", requestId });
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}
