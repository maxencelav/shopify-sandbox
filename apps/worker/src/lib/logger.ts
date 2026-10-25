import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "worker" },
  redact: {
    paths: ["*.customer.email", "*.customer.phone", "*.customer.name", "customer"],
    censor: "[redacted]",
  },
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }
    : {}),
});
