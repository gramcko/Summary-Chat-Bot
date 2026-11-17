# syntax=docker/dockerfile:1
#
# Summarly Chat Bot — one multi-stage image for every Node.js service:
#   backend, summary-worker, bot-worker and the `migrate` one-shot.
# Docker Compose overrides the command per service (docker-compose.yml).
#
# Build context is the repository root:
#   docker build -f docker/app.Dockerfile -t summarly-app:local .
#
# Node 22 (LTS) is the target: Next 16 needs >= 20.9 and Node 22 is the
# supported LTS line for this project.

# ---------------------------------------------------------------------------
# Build stage: install the workspace, compile contracts + backend + workers.
# The dashboard is intentionally NOT built here (it has its own image).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_fund=false \
    npm_config_update_notifier=false

WORKDIR /app

# Toolchain for dependencies that may need to compile a native addon on a
# platform without a prebuilt binary. Kept in the build stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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

# Sources needed by the compiled services (and by the migration scripts).
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY backend backend
COPY summary-worker summary-worker
COPY bot-worker bot-worker

RUN npm run build -w @summarly/contracts \
 && npm run build -w @summarly/backend \
 && npm run build -w @summarly/summary-worker \
 && npm run build -w @summarly/bot-worker

# ---------------------------------------------------------------------------
# Runtime stage: non-root, production dependencies plus the build output.
# `tsx` (a root devDependency) stays installed on purpose: `npm run migrate`
# and the recovery scripts run TypeScript sources through it.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# node_modules keeps the npm-workspace symlinks (@summarly/contracts ->
# ../../packages/contracts), so the workspace package.json files below must
# stay at their original relative paths.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist

COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/migrations ./backend/migrations
COPY --from=build --chown=node:node /app/backend/scripts ./backend/scripts
# scripts/migrate.ts and scripts/reset-password.ts import ../src/lib/load-env.js;
# tsx resolves that to the TypeScript source, so src/ is part of the runtime.
COPY --from=build --chown=node:node /app/backend/src ./backend/src

COPY --from=build --chown=node:node /app/summary-worker/package.json ./summary-worker/package.json
COPY --from=build --chown=node:node /app/summary-worker/dist ./summary-worker/dist

COPY --from=build --chown=node:node /app/bot-worker/package.json ./bot-worker/package.json
COPY --from=build --chown=node:node /app/bot-worker/dist ./bot-worker/dist

# WhatsApp (Baileys) session state lives on the `wa-session` volume. The
# directory is owner-only (0700): bot-worker fails fast otherwise (ADR 0004).
RUN mkdir -p /data/wa-session \
 && chown -R node:node /data \
 && chmod 0700 /data/wa-session

USER node

# Default command: the backend. Compose overrides it for summary-worker,
# bot-worker and the migration one-shot.
CMD ["node", "backend/dist/index.js"]
