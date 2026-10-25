# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/erp/Dockerfile .

# --- stage 1: dependencies (cached separately from the code) ---
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY apps/erp/package.json apps/erp/
COPY apps/worker/package.json apps/worker/
COPY apps/shopify-app/package.json apps/shopify-app/
RUN npm ci --omit=dev --workspace @sync/erp --include-workspace-root

# --- stage 2: runtime image ---
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tsx runs TypeScript directly: no compile step, so no drift between
# what is tested and what runs.
RUN npm install -g tsx@4

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# tsx only applies a tsconfig to the files it includes: point it at the
# service one (JSX runtime, module settings), which extends the base config.
COPY tsconfig.base.json ./
ENV TSX_TSCONFIG_PATH=apps/erp/tsconfig.json
COPY packages/db ./packages/db
COPY apps/erp ./apps/erp

# Do not run as root in the container.
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ERP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No shell as PID 1: the Node process receives SIGTERM directly and
# triggers its graceful shutdown.
CMD ["tsx", "apps/erp/src/index.ts"]
