import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { REALTIME_LIMITS, REALTIME_PROTOCOL } from "@metafarm/domain";
import type { Deps } from "./deps";
import { contextPlugin } from "./plugins/context";
import { idempotencyPlugin } from "./plugins/idempotency";
import { metricsPlugin } from "./plugins/metrics";
import { previewGatePlugin } from "./plugins/preview-gate";
import { securityPlugin } from "./plugins/security";
import { chainRoutes } from "./routes/chain";
import { integrationRoutes } from "./routes/integrations";
import { realtimeRoutes, type RealtimeLimits } from "./routes/realtime";
import { farmRoutes } from "./routes/farms";
import { healthRoutes } from "./routes/health";
import { mediaRoutes } from "./routes/media";
import { teamRoutes } from "./routes/team";
import { observationRoutes } from "./routes/observations";
import { planningRoutes } from "./routes/planning";
import { playerWalletRoutes } from "./routes/player-wallets";
import { taskRoutes } from "./routes/tasks";
import { harvestRoutes } from "./routes/harvests";
import { inventoryRoutes } from "./routes/inventory";
import { seasonRoutes } from "./routes/seasons";
import { equipmentRoutes } from "./routes/equipment";
import { sensorRoutes } from "./routes/sensors";
import { notificationRoutes } from "./routes/notifications";
import { exportRoutes } from "./routes/exports";
import { reportRoutes } from "./routes/reports";
import { rwaRoutes } from "./routes/rwa";
import { twinRoutes } from "./routes/twin";
import { twinSnapshotRoutes } from "./routes/twin-snapshots";
import { twinAnchorRoutes } from "./routes/twin-anchors";
import { yieldRoutes, yieldWorkflowRoutes } from "./routes/yield";
import { partyLinkRoutes } from "./routes/party-links";
import { holderYieldRoutes } from "./routes/holder-yield";
import { marketplaceRoutes } from "./routes/marketplace";

export interface BuildOptions {
  deps: Deps;
  isDraining?: () => boolean;
  /** Serve Swagger UI at /docs. Defaults to on outside production. */
  docs?: boolean;
  /** Realtime channel timings (tests shorten them); only used when REALTIME_EVENTS_ENABLED is on. */
  realtime?: Partial<RealtimeLimits>;
}

export async function buildApp({ deps, isDraining = () => false, docs, realtime }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's Logger is runtime-compatible with Fastify's logger; the cast keeps the
    // instance typed as the default FastifyInstance used by plugins and tests.
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: deps.env.BODY_LIMIT_BYTES,
    trustProxy: deps.env.TRUST_PROXY,
    requestIdHeader: "x-request-id",
    // Accept a caller-provided request id only if it is well-formed.
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    },
    // Reject prototype-pollution keys in JSON bodies.
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    maxParamLength: 200,
  });

  await app.register(securityPlugin, { env: deps.env, rateLimitRedis: deps.rateLimitRedis });
  // Before every route, so that every response is counted.
  await app.register(metricsPlugin, { token: deps.env.METRICS_TOKEN });
  await app.register(contextPlugin, { deps });
  // Before every route (health included, which it lets through), so nothing is reachable around it.
  await app.register(previewGatePlugin, { enabled: deps.env.PREVIEW_ACCESS_GATE });
  await app.register(idempotencyPlugin);
  await app.register(healthRoutes, { isDraining });

  if (docs ?? deps.env.APP_ENV !== "production") {
    const require = createRequire(import.meta.url);
    const specPath = process.env.OPENAPI_SPEC_PATH ?? path.join(path.dirname(require.resolve("@metafarm/contracts/package.json")), "openapi.yaml");
    await app.register(import("@fastify/swagger"), { mode: "static", specification: { path: specPath, baseDir: path.dirname(specPath) } });
    await app.register(async (scope) => {
      // Swagger UI needs inline scripts/styles; relax CSP for this scope only.
      scope.addHook("onSend", async (_req, reply) => {
        reply.header(
          "content-security-policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        );
      });
      await scope.register(import("@fastify/swagger-ui"), { routePrefix: "/docs" });
    });
  }

  await app.register(farmRoutes);
  await app.register(planningRoutes);
  await app.register(observationRoutes);
  await app.register(mediaRoutes);
  await app.register(teamRoutes);
  await app.register(taskRoutes);
  await app.register(harvestRoutes);
  await app.register(inventoryRoutes);
  await app.register(seasonRoutes);
  await app.register(equipmentRoutes);
  await app.register(sensorRoutes);
  await app.register(notificationRoutes);
  await app.register(exportRoutes);
  await app.register(reportRoutes);
  await app.register(rwaRoutes);
  await app.register(chainRoutes);
  await app.register(playerWalletRoutes);
  await app.register(twinRoutes);
  await app.register(twinSnapshotRoutes);
  await app.register(twinAnchorRoutes);
  await app.register(yieldRoutes);
  await app.register(yieldWorkflowRoutes);
  await app.register(partyLinkRoutes);
  await app.register(holderYieldRoutes);
  await app.register(integrationRoutes);
  await app.register(marketplaceRoutes);
  // Realtime channel (WebSocket): registered only when switched on, so the route table is unchanged otherwise.
  if (deps.env.REALTIME_EVENTS_ENABLED) {
    await app.register(websocket, {
      options: {
        maxPayload: REALTIME_LIMITS.maxClientMessageBytes,
        // Answer the realtime subprotocol only; a `bearer.<token>` entry is a credential, never echoed back.
        handleProtocols: (protocols: Set<string>) => (protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false),
      },
    });
    await app.register(realtimeRoutes, { limits: realtime });
  }

  return app;
}
