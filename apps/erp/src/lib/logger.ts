import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "erp" },
  redact: {
    // Never log personal data in clear text.
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "req.headers.cookie",
      "customer.email",
      "customer.phone",
      "customer.name",
      "customer.address",
      "*.customer.email",
      "*.customer.phone",
      "*.customer.name",
    ],
    censor: "[redacted]",
  },
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }
    : {}),
});

export type Logger = typeof logger;
