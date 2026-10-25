# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/worker/Dockerfile .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY apps/erp/package.json apps/erp/
COPY apps/worker/package.json apps/worker/
COPY apps/shopify-app/package.json apps/shopify-app/
RUN npm ci --omit=dev --workspace @sync/worker --include-workspace-root

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g tsx@4

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# tsx only applies a tsconfig to the files it includes: point it at the
# service one (JSX runtime, module settings), which extends the base config.
COPY tsconfig.base.json ./
ENV TSX_TSCONFIG_PATH=apps/worker/tsconfig.json
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker

USER node

# The worker exposes no port: its health is read from the pg-boss queues.
CMD ["tsx", "apps/worker/src/index.ts"]
