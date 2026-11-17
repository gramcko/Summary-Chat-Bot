# syntax=docker/dockerfile:1
#
# Summarly Chat Bot — dashboard image (Next.js admin UI).
#
# Build context is the repository root:
#   docker build -f docker/dashboard.Dockerfile \
#     --build-arg BACKEND_URL=http://backend:3000 \
#     -t summarly-dashboard:local .
#
# BACKEND_URL is a BUILD argument, not just a runtime variable: Next bakes
# the `/api/:path*` rewrite destination into .next/routes-manifest.json when
# the config is evaluated during `next build` (see dashboard/next.config.ts).

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1 \
    npm_config_fund=false \
    npm_config_update_notifier=false

WORKDIR /app

ARG BACKEND_URL=http://backend:3000
ENV BACKEND_URL=${BACKEND_URL}

# Manifests first so the dependency layer is cached until a package file
# changes. Every workspace listed in the root package.json must be present
# for `npm ci` to resolve the lockfile.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY summary-worker/package.json summary-worker/
COPY bot-worker/package.json bot-worker/
COPY dashboard/package.json dashboard/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY dashboard dashboard

# `public/` is optional in this repository; create it so the runtime COPY
# below does not depend on whether it exists.
RUN mkdir -p dashboard/public \
 && npm run build -w @summarly/contracts \
 && npm run build -w @summarly/dashboard

# ---------------------------------------------------------------------------
# Runtime stage: non-root, Next.js production server on 0.0.0.0:3000.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# The dashboard imports the compiled shared contracts package.
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist

COPY --from=build --chown=node:node /app/dashboard/package.json ./dashboard/package.json
COPY --from=build --chown=node:node /app/dashboard/next.config.ts ./dashboard/next.config.ts
COPY --from=build --chown=node:node /app/dashboard/.next ./dashboard/.next
COPY --from=build --chown=node:node /app/dashboard/public ./dashboard/public

USER node
WORKDIR /app/dashboard

# `next start` reads the baked routes manifest (rewrites to BACKEND_URL) and
# binds every interface so the Caddy container can reach it.
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
