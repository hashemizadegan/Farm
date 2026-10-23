# syntax=docker/dockerfile:1.7
#
# One Dockerfile for every service. It builds the app named by APP:
#   api | web | worker | scheduler
#
# On Railway, APP defaults to the service's name (Railway passes
# RAILWAY_SERVICE_NAME into the build), so services named api, web, worker and
# scheduler need no build settings at all. Override with a service variable
# APP=<name> if your service names differ.
#
# Locally / in CI:   docker build --build-arg APP=api -t metafarm-api .
#
# BuildKit only builds the stages the selected target needs.

ARG NODE_VERSION=22-bookworm-slim
ARG RAILWAY_SERVICE_NAME=api
ARG APP=${RAILWAY_SERVICE_NAME}

# ── Shared install ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
# Install from the lockfile when present (commit pnpm-lock.yaml to make builds reproducible).
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install --no-frozen-lockfile; fi

# ── Node services (api, worker, scheduler) ────────────────────────────────
FROM deps AS build-api
RUN pnpm --filter @metafarm/api build && pnpm --filter @metafarm/api deploy --prod --legacy /out

FROM deps AS build-worker
RUN pnpm --filter @metafarm/worker build && pnpm --filter @metafarm/worker deploy --prod --legacy /out

FROM deps AS build-scheduler
RUN pnpm --filter @metafarm/scheduler build && pnpm --filter @metafarm/scheduler deploy --prod --legacy /out

FROM node:${NODE_VERSION} AS app-api
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations \
    OPENAPI_SPEC_PATH=/app/contracts/openapi.yaml
WORKDIR /app
COPY --from=build-api --chown=node:node /out/node_modules ./node_modules
COPY --from=build-api --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build-api --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build-api --chown=node:node /repo/packages/db/migrations ./migrations
COPY --from=build-api --chown=node:node /repo/packages/contracts/openapi.yaml /repo/packages/contracts/nft-metadata.schema.json ./contracts/
USER node
EXPOSE 4000
# exec form: node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM node:${NODE_VERSION} AS app-worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build-worker --chown=node:node /out/node_modules ./node_modules
COPY --from=build-worker --chown=node:node /repo/apps/worker/dist ./dist
COPY --from=build-worker --chown=node:node /repo/apps/worker/package.json ./package.json
USER node
EXPOSE 4100
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM node:${NODE_VERSION} AS app-scheduler
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build-scheduler --chown=node:node /out/node_modules ./node_modules
COPY --from=build-scheduler --chown=node:node /repo/apps/scheduler/dist ./dist
COPY --from=build-scheduler --chown=node:node /repo/apps/scheduler/package.json ./package.json
USER node
EXPOSE 4200
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── Web (Next.js) ─────────────────────────────────────────────────────────
FROM deps AS build-web
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time. Railway
# passes service variables to the build only when the Dockerfile declares them.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_MAP_STYLE_URL
ARG NEXT_PUBLIC_MAP_ATTRIBUTION
ARG NEXT_PUBLIC_MAP_CONNECT_SRC
ARG NEXT_PUBLIC_UPLOAD_CONNECT_SRC
# Realtime channel URL (wss://…/v1/realtime); unset = polling only. Refused by the build when APP_ENV is deployed.
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_CESIUM_ENABLED=false
ARG NEXT_PUBLIC_WALLET_CHAIN_ID
ARG NEXT_PUBLIC_OIDC_AUTHORITY
ARG NEXT_PUBLIC_OIDC_CLIENT_ID
ARG NEXT_PUBLIC_OIDC_AUDIENCE
# Y10 staff pages (/yield): off unless the service sets it. next.config.ts refuses it at build time when APP_ENV is
# staging or production, so APP_ENV is passed to the build too (build stage only; the runtime image is separate).
ARG NEXT_PUBLIC_YIELD_PAGES_ENABLED=false
ARG APP_ENV
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL \
    NEXT_PUBLIC_MAP_ATTRIBUTION=$NEXT_PUBLIC_MAP_ATTRIBUTION \
    NEXT_PUBLIC_MAP_CONNECT_SRC=$NEXT_PUBLIC_MAP_CONNECT_SRC \
    NEXT_PUBLIC_UPLOAD_CONNECT_SRC=$NEXT_PUBLIC_UPLOAD_CONNECT_SRC \
    NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL \
    NEXT_PUBLIC_CESIUM_ENABLED=$NEXT_PUBLIC_CESIUM_ENABLED \
    NEXT_PUBLIC_WALLET_CHAIN_ID=$NEXT_PUBLIC_WALLET_CHAIN_ID \
    NEXT_PUBLIC_OIDC_AUTHORITY=$NEXT_PUBLIC_OIDC_AUTHORITY \
    NEXT_PUBLIC_OIDC_CLIENT_ID=$NEXT_PUBLIC_OIDC_CLIENT_ID \
    NEXT_PUBLIC_OIDC_AUDIENCE=$NEXT_PUBLIC_OIDC_AUDIENCE \
    NEXT_PUBLIC_YIELD_PAGES_ENABLED=$NEXT_PUBLIC_YIELD_PAGES_ENABLED \
    APP_ENV=$APP_ENV
RUN pnpm --filter @metafarm/web build

FROM node:${NODE_VERSION} AS app-web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Standalone output mirrors the monorepo layout; server.js lives under apps/web.
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# Standalone output does not include public/ (it holds MapLibre's worker script).
COPY --from=build-web --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ── Preview seed runner (isolated previews only) ──────────────────────────
# A one-off container that seeds a NEW, isolated preview database with the demo workspace and the simulation
# yield cycles (apps/api/src/scripts/preview-seed-runner.ts). It is never built for api, web, worker or scheduler:
# BuildKit builds only the stages the selected APP needs, so their images are unchanged. Select it with
# APP=seed-runner on a dedicated service of the preview project. The runner refuses unless APP_ENV is development
# or test, the database holds no workspace other than the demo one, and migrations reach 0029.
FROM deps AS app-seed-runner
ENV NODE_ENV=development
WORKDIR /repo/apps/api
USER node
CMD ["node", "--import", "tsx", "src/scripts/preview-seed-runner.ts"]

# ── Select the app ────────────────────────────────────────────────────────
FROM app-${APP} AS final
