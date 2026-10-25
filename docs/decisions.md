# Design decisions

## pg-boss rather than BullMQ

The queue lives in the existing Postgres: no Redis to host, one service to monitor, and an
enqueue can be part of an application transaction. pg-boss provides retries with
exponential backoff, bounded concurrency, dead-letter queues, scheduled jobs and singleton
jobs. The expected load is a few orders per second, far below its limits. BullMQ would fit
a high-throughput workload better.

## One Postgres, separate schemas

The app tables, the pg-boss queue and the mini-ERP share one database, in the `public`,
`pgboss` and `erp` schemas. This keeps the project to a single service to run. A real ERP
would be a separate system; the mini-ERP is a stub for testing the integration.

## Tests against a real database

Idempotency here depends on unique constraints, transactions and row locks, which a mocked
database cannot reproduce. Tests start a disposable Postgres with Testcontainers and run
the migration on it.

## tsx instead of a build step

Services run TypeScript directly with tsx, so what is tested is what runs. A production
deployment would add a build step.

## No retry on a 409

An out-of-stock order goes straight to the dead-letter queue. Retrying cannot create stock,
and the order needs a human decision.

## Metafield writes do not fail the job

Once the ERP has the order, the sync is done. A failed metafield write is logged as
`metafields.write_failed` and not retried: the order is marked as synced, so later jobs for
it exit early. A periodic job re-writing missing metafields would close that gap.

## The ERP owns stock quantities

The catalog import sends SKUs and titles only. Quantities are set by the ERP and never
overwritten by an import, which also makes the import safe to repeat without an
idempotency key.

## Better Auth for the ERP UI

Password hashing, sessions, cookie flags and login rate limiting come from the library
rather than custom code. Public sign-up is disabled; accounts come from a seed script. The
Shopify app needs none of this: Shopify handles its authentication.

## Server-rendered ERP UI with Bootstrap 6

The UI is rendered by Hono with `hono/jsx` and styled with Bootstrap 6, served from
`node_modules`. There is no client bundle and no build step. Bootstrap 6 is still in alpha,
so the version is pinned exactly.

## Polaris React in the Shopify app

The app screen uses `@shopify/polaris` (React), as provided by the official template.
Shopify now recommends Polaris web components; migrating the screen is a follow-up.

## Request log retention

The request log is never pruned. A scheduled job deleting old rows would be needed outside
a demo.
