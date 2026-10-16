# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/api/Dockerfile .
ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
# Install from the lockfile when present (commit pnpm-lock.yaml after the first install).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install --no-frozen-lockfile; fi
RUN pnpm --filter @metafarm/api build
# Self-contained production install of the API's third-party dependencies.
RUN pnpm --filter @metafarm/api deploy --prod --legacy /out

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations \
    OPENAPI_SPEC_PATH=/app/contracts/openapi.yaml
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
COPY --from=build --chown=node:node /repo/packages/contracts/openapi.yaml /repo/packages/contracts/nft-metadata.schema.json ./contracts/
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "--enable-source-maps", "dist/main.js"]
