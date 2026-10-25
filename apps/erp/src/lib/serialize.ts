import { createHmac } from "node:crypto";
import type { ErpOrder } from "@sync/db/schema";
import type { UserRole } from "@sync/db/schema";

/**
 * Personal data masking for the demo role.
 *
 * Single choke point: every outgoing order goes through serializeOrder.
 * Masking in CSS or client-side JS would leave the real value in the network
 * response — here it never leaves the server.
 */

export type SerializedOrder = {
  id: string;
  externalReference: string;
  status: ErpOrder["status"];
  customer: {
    /** Stable HMAC-derived pseudonym: spot a returning customer without identifying them. */
    pseudonym: string;
    name: string;
    email: string;
    phone: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    /** True when the fields above are masked. */
    masked: boolean;
  };
  lines: ErpOrder["lines"];
  total: string;
  currency: string;
  trackingNumber: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `client-a3f9`: stable for a given email, irreversible without the secret. */
export function pseudonymize(email: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(email.trim().toLowerCase())
    .digest("hex");
  return `client-${digest.slice(0, 4)}`;
}

export function maskName(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}.`)
    .join(" ");
  return initials || "—";
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 1);
  const tld = domain.includes(".") ? domain.slice(domain.lastIndexOf(".")) : "";
  return `${head}***@***${tld}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-2);
  return tail ? `••••••${tail}` : "••••••";
}

export function serializeOrder(order: ErpOrder, role: UserRole, secret: string): SerializedOrder {
  const address = order.customer.address ?? {};
  const base = {
    id: order.id,
    externalReference: order.externalReference,
    status: order.status,
    lines: order.lines,
    total: order.total,
    currency: order.currency,
    trackingNumber: order.trackingNumber,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
  const pseudonym = pseudonymize(order.customer.email, secret);

  if (role === "admin") {
    return {
      ...base,
      customer: {
        pseudonym,
        name: order.customer.name,
        email: order.customer.email,
        phone: order.customer.phone ?? null,
        city: address.city ?? null,
        postalCode: address.postalCode ?? null,
        country: address.country ?? null,
        masked: false,
      },
    };
  }

  return {
    ...base,
    customer: {
      pseudonym,
      name: maskName(order.customer.name),
      email: maskEmail(order.customer.email),
      phone: order.customer.phone ? maskPhone(order.customer.phone) : null,
      // City and postal code stay visible: useful, barely identifying.
      city: address.city ?? null,
      postalCode: address.postalCode ?? null,
      country: address.country ?? null,
      masked: true,
    },
  };
}
