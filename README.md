# Shopify → ERP order sync

An embedded Shopify app that forwards every new order to an ERP, without losing or
duplicating orders when webhooks are replayed, requests time out or the ERP is down.

The repository includes a mini-ERP with a chaos mode (outages, latency, lost responses) used
to exercise those failure cases.

## Quick start

Requirements: Node 22+, Docker.

```bash
cp .env.example .env        # then replace the secrets
npm install
npm run db:up               # Postgres 17 on port 5433
npm run db:migrate
npm run db:seed             # 20 SKUs in the ERP stock
npm run erp:accounts        # admin and demo accounts for the ERP UI
```

Then, in three terminals:

```bash
npm run dev:erp             # ERP API and UI on http://localhost:8787
npm run dev:worker          # pg-boss worker
npm run demo -- --chaos     # simulates an orders/create webhook with chaos mode on
```

Sign in to the ERP UI with the accounts from `.env` and open **Request log** to follow the
order through its retries. `npm run demo -- --oos` simulates an out-of-stock order.

## With a Shopify store

```bash
npm install -g @shopify/cli
cd apps/shopify-app
shopify app config link     # creates shopify.app.toml from your Partners account
shopify app dev             # installs the app on your dev store
```

Set `SHOPIFY_SHOP` in `.env`, plus either `SHOPIFY_ADMIN_TOKEN` or the
`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` of a Dev Dashboard app installed on the
store (scopes: `read_orders`, `write_orders`, `read_products`). Then import the store
catalog so the ERP knows its SKUs:

```bash
npm run catalog:import                   # new SKUs start with 10 units
npm run catalog:import -- --quantity 50
```

## Repository layout

```
apps/shopify-app/     embedded app: webhooks, Polaris screen, ERP callback
apps/worker/          pg-boss jobs: order sync, nightly reconciliation, catalog import
apps/erp/             mini-ERP: Hono API, server-rendered UI, chaos mode
packages/db/          Drizzle schema, migration, seed
scripts/              demo order and catalog import CLIs
test/                 Testcontainers setup shared by the test suite
docs/                 architecture and design decisions
```

## Tests

```bash
npm test              # 50 tests against a real Postgres (Testcontainers, needs Docker)
npm run typecheck
```

## Documentation

- [Architecture](docs/architecture.md): order flow, idempotency, error handling,
  reconciliation, the mini-ERP.
- [Design decisions](docs/decisions.md): what was chosen and why.
