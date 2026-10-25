/**
 * Structured errors: { code, message, retryable }.
 *
 * `retryable` is the contract with the worker: false => immediate dead-letter,
 * true => retry with backoff. The worker never guesses from the HTTP status
 * alone.
 */
export type ErpErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export class ErpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly headers: Record<string, string>;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
    headers?: Record<string, string>;
  }) {
    super(opts.message);
    this.name = "ErpError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable;
    if (opts.details !== undefined) this.details = opts.details;
    this.headers = opts.headers ?? {};
  }

  toBody(): ErpErrorBody {
    const body: ErpErrorBody = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** 400 — malformed request. Permanent. */
export const badRequest = (message: string, details?: unknown) =>
  new ErpError({ status: 400, code: "bad_request", message, retryable: false, details });

/** 401 — invalid API key or session. Permanent. */
export const unauthorized = (message = "Invalid API key") =>
  new ErpError({ status: 401, code: "unauthorized", message, retryable: false });

/** 403 — insufficient role (the demo account is read-only). */
export const forbidden = (message = "Admin role required") =>
  new ErpError({ status: 403, code: "forbidden", message, retryable: false });

/** 404 */
export const notFound = (message = "Resource not found") =>
  new ErpError({ status: 404, code: "not_found", message, retryable: false });

/** 409 — out of stock. Permanent: retrying will not bring the stock back. */
export const outOfStock = (sku: string, available: number, requested: number) =>
  new ErpError({
    status: 409,
    code: "out_of_stock",
    message: `Insufficient stock for ${sku}: ${available} available, ${requested} requested`,
    retryable: false,
    details: { sku, available, requested },
  });

/** 422 — validation, or idempotency key replayed with a different body. */
export const unprocessable = (message: string, details?: unknown) =>
  new ErpError({ status: 422, code: "unprocessable_entity", message, retryable: false, details });

export const idempotencyKeyReused = () =>
  new ErpError({
    status: 422,
    code: "idempotency_key_reused",
    message: "This idempotency key was already used with a different body",
    retryable: false,
  });

/** 429 — throttling. Temporary, with a Retry-After the worker honors. */
export const throttled = (retryAfterSeconds: number) =>
  new ErpError({
    status: 429,
    code: "rate_limited",
    message: "Too many requests",
    retryable: true,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });

/** 503 — ERP unavailable. Temporary. */
export const unavailable = (message = "ERP temporarily unavailable") =>
  new ErpError({ status: 503, code: "service_unavailable", message, retryable: true });
