import type { FastifyInstance } from "fastify";
import { recordWebhookReceipt, writeSystemAudit } from "@metafarm/db";
import { checkNftMetadataContent, nftMetadataSchema, uuid } from "@metafarm/domain";
import { verifyWebhookSignature } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, hashIp, parse } from "../lib/http";

export async function chainRoutes(app: FastifyInstance) {
  const { env } = app.deps;

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
      const body = parse(z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100), data: z.record(z.unknown()).optional() }), req.body);
      const fresh = await recordWebhookReceipt(app.deps.pool, provider, body.id);
      if (!fresh) return reply.status(200).send({ status: "duplicate" });
      await writeSystemAudit(app.deps.pool, null, {
        actorType: "webhook",
        action: "webhook.received",
        metadata: { provider, type: body.type, eventId: body.id },
        requestId: req.id,
      });
      // TODO(provider-config): map provider event types to tenant/farm/sensor and enqueue
      // observation normalisation with provenance `sensor-reported` or `provider-observation`.
      // The mapping must resolve the tenant from a registered sensor/integration id, never from the payload alone.
      return reply.status(202).send({ status: "accepted" });
    });
  });
}
