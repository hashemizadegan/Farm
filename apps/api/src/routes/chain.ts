import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isOwnershipIndexTarget, recordWebhookReceipt, withSystem, writeSystemAudit } from "@metafarm/db";
import {
  CHAIN_EVENT_ADAPTERS,
  ChainEventRefusal,
  QUEUES,
  assertChainEventNetwork,
  checkNftMetadataContent,
  isActionableOwnershipHint,
  nftMetadataSchema,
  uuid,
  type NormalizedChainEvent,
  type OwnershipIndexJob,
} from "@metafarm/domain";
import { verifyWebhookSignature } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, hashIp, parse } from "../lib/http";

export async function chainRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  // Fail closed at start-up: every provider allowed to post chain events needs an adapter (no guessing at payloads).
  for (const p of env.CHAIN_EVENT_PROVIDERS) {
    if (!CHAIN_EVENT_ADAPTERS[p]) throw new Error(`CHAIN_EVENT_PROVIDERS names "${p}", which has no chain event adapter (known: ${Object.keys(CHAIN_EVENT_ADAPTERS).join(", ")})`);
  }

  // ── NFT metadata validation ──────────────────────────────────────────────
  app.post("/v1/tenants/:tenantId/nft/metadata/validate", async (req) => {
    parse(z.object({ tenantId: uuid }), req.params);
    return app.inTenant(req, "nft:manage", async () => {
      const r = nftMetadataSchema.safeParse(req.body);
      if (!r.success) {
        return { valid: false, issues: r.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", message: i.message })) };
      }
      const issues = checkNftMetadataContent(r.data);
      return { valid: issues.length === 0, issues };
    });
  });

  // ── Signed provider webhooks ─────────────────────────────────────────────
  await app.register(async (scope) => {
    // Keep the exact bytes: signatures are computed over the raw body.
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch {
        done(new HttpError(400, "invalid_json", "body is not valid JSON"), undefined);
      }
    });

    scope.post("/v1/webhooks/:provider", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { provider } = parse(z.object({ provider: z.string().regex(/^[a-z0-9-]{1,40}$/) }), req.params);
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const sig = req.headers["x-webhook-signature"];
      const result = verifyWebhookSignature({
        header: Array.isArray(sig) ? sig[0] : sig,
        rawBody,
        secrets: env.WEBHOOK_SIGNING_SECRETS,
        toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds: Math.floor(app.deps.now().getTime() / 1000),
      });
      if (!result.ok) {
        await writeSystemAudit(app.deps.pool, null, {
          actorType: "webhook",
          action: "webhook.rejected",
          outcome: "denied",
          metadata: { provider, reason: result.reason },
          requestId: req.id,
          ipHash: hashIp(req.ip),
        }).catch(() => undefined);
        throw new HttpError(401, "invalid_signature", "webhook signature verification failed");
      }
      // Chain event providers: normalized and checked before anything is stored (see handleChainEvent).
      if (CHAIN_EVENT_ADAPTERS[provider]) {
        if (!env.CHAIN_EVENT_PROVIDERS.includes(provider)) throw new HttpError(404, "provider_not_enabled", "this provider is not enabled on this deployment");
        const out = await handleChainEvent(app, provider, req.body, rawBody, { requestId: req.id, ipHash: hashIp(req.ip) });
        return reply.status(out.status).send(out.body);
      }
      const body = parse(z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100), data: z.record(z.unknown()).optional() }), req.body);
      const fresh = await recordWebhookReceipt(app.deps.pool, provider, body.id);
      if (!fresh) return reply.status(200).send({ status: "duplicate" });
      await writeSystemAudit(app.deps.pool, null, {
        actorType: "webhook",
        action: "webhook.received",
        metadata: { provider, type: body.type, eventId: body.id },
        requestId: req.id,
      });
      // Decision pending (docs/provider-capabilities.md, "telemetry webhooks"): other providers' events (sensor and
      // observation feeds) are receipted and audited only. Mapping them needs a registered-integration table that
      // resolves the tenant from the integration id, never from the payload; until that exists nothing is ingested.
      return reply.status(202).send({ status: "accepted" });
    });
  });
}

export type ReindexOutcome = "queued" | "not_tracked" | "indexer_disabled" | "not_an_ownership_hint";

/**
 * One chain event from an enabled provider: normalize (adapter), check the deployment's network, then record the
 * receipt (idempotency: one per provider event id) and an audit row with the normalized summary and the SHA-256 of
 * the exact body (the body itself is not kept). An actionable ownership hint for a tracked asset asks the ownership
 * indexer to re-read that asset from the verified chain source; the event itself never writes ownership.
 * Refusals answer 422 with a stable code and store nothing but a rejection audit row.
 */
export async function handleChainEvent(
  app: FastifyInstance,
  provider: string,
  body: unknown,
  rawBody: Buffer,
  meta: { requestId: string; ipHash: string | undefined },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { env, pool, jobs, now } = app.deps;
  const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
  let events: NormalizedChainEvent[];
  try {
    events = CHAIN_EVENT_ADAPTERS[provider]!.normalize({ provider, body, payloadSha256 });
    for (const e of events) assertChainEventNetwork(e, env.RWA_SOLANA_NETWORK);
  } catch (e) {
    if (!(e instanceof ChainEventRefusal)) throw e;
    await writeSystemAudit(pool, null, {
      actorType: "webhook",
      action: "webhook.rejected",
      outcome: "denied",
      metadata: { provider, reason: `chain_event_${e.code}`, payloadSha256 },
      requestId: meta.requestId,
      ipHash: meta.ipHash,
    }).catch(() => undefined);
    throw new HttpError(422, `chain_event_${e.code}`, e.message);
  }
  const eventId = events[0]!.rawReference.eventId;
  if (!(await recordWebhookReceipt(pool, provider, eventId))) return { status: 200, body: { status: "duplicate" } };

  const outcomes: ReindexOutcome[] = [];
  for (const e of events) {
    if (!isActionableOwnershipHint(e)) outcomes.push("not_an_ownership_hint");
    else if (!env.TWIN_OWNERSHIP_INDEX_ENABLED) outcomes.push("indexer_disabled");
    else if (!(await withSystem(pool, (tx) => isOwnershipIndexTarget(tx, { network: e.network, rail: e.rail, id: e.assetId })))) outcomes.push("not_tracked");
    else {
      // One re-read per asset and minute, however many events arrive (the job id is the idempotency key).
      const bucket = `webhook:${now().toISOString().slice(0, 16)}`;
      await jobs.enqueue(QUEUES.ownershipIndex, { network: e.network as OwnershipIndexJob["network"], rail: e.rail as OwnershipIndexJob["rail"], assetId: e.assetId, bucket });
      outcomes.push("queued");
    }
  }
  await writeSystemAudit(pool, null, {
    actorType: "webhook",
    action: "webhook.received",
    metadata: {
      provider,
      eventId,
      payloadSha256,
      events: events.map((e, i) => ({ scheme: e.scheme, kind: e.kind, network: e.network, rail: e.rail, assetId: e.assetId, signature: e.transaction.signature, slot: e.transaction.slot, finality: e.finality, reindex: outcomes[i] })),
    },
    requestId: meta.requestId,
  });
  return { status: 202, body: { status: "accepted", events: events.map((e, i) => ({ kind: e.kind, reindex: outcomes[i] })) } };
}
