import type { FastifyInstance } from "fastify";
import {
  consumeWalletNonce,
  linkWallet,
  peekWalletNonce,
  recordWebhookReceipt,
  storeWalletNonce,
  writeSystemAudit,
} from "@metafarm/db";
import {
  WALLET_LINK_STATEMENT,
  WalletAuthError,
  buildWalletAuthMessage,
  checkNftMetadataContent,
  nftMetadataSchema,
  uuid,
  verifyWalletAuth,
  walletVerifySchema,
} from "@metafarm/domain";
import { generateNonce, verifyWebhookSignature } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, hashIp, parse } from "../lib/http";

export async function chainRoutes(app: FastifyInstance) {
  const { env } = app.deps;

  // ── Wallet linking (EIP-4361 style) ──────────────────────────────────────
  app.post(
    "/v1/wallet/nonce",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      await app.authenticate(req);
      const body = parse(
        z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.number().int().positive() }),
        req.body,
      );
      if (!env.WALLET_ALLOWED_CHAIN_IDS.includes(body.chainId)) {
        throw new HttpError(400, "chain_not_allowed", "chain id is not allowed");
      }
      const nonce = generateNonce();
      const issued = app.deps.now();
      const expires = new Date(issued.getTime() + env.WALLET_NONCE_TTL_SECONDS * 1000);
      await storeWalletNonce(app.deps.pool, req.user!.id, nonce, env.WALLET_NONCE_TTL_SECONDS);
      const message = buildWalletAuthMessage({
        domain: env.WALLET_AUTH_DOMAIN,
        address: body.address,
        statement: WALLET_LINK_STATEMENT,
        uri: env.WALLET_AUTH_URI,
        version: "1",
        chainId: body.chainId,
        nonce,
        issuedAt: issued.toISOString(),
        expirationTime: expires.toISOString(),
      });
      return { nonce, message, expiresAt: expires.toISOString() };
    },
  );

  app.post(
    "/v1/wallet/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      await app.authenticate(req);
      const body = parse(walletVerifySchema, req.body);
      const userId = req.user!.id;
      try {
        const m = await verifyWalletAuth(body.message, body.signature as `0x${string}`, {
          expectedDomain: env.WALLET_AUTH_DOMAIN,
          expectedUri: env.WALLET_AUTH_URI,
          allowedChainIds: env.WALLET_ALLOWED_CHAIN_IDS,
          expectedNonce: await peekWalletNonce(app.deps.pool, userId),
          now: app.deps.now(),
          maxAgeSeconds: env.WALLET_NONCE_TTL_SECONDS,
          recoverAddress: app.deps.recoverMessageAddress,
        });
        // Atomic single use: a concurrent replay loses this race.
        if (!(await consumeWalletNonce(app.deps.pool, userId, m.nonce))) {
          throw new WalletAuthError("NONCE_MISMATCH", "nonce already used");
        }
        await linkWallet(app.deps.pool, userId, m.address, m.chainId);
        await writeSystemAudit(app.deps.pool, null, {
          actorType: "user",
          actorUserId: userId,
          action: "wallet.linked",
          targetType: "wallet",
          // Store the chain only; the address-to-user mapping lives in wallet_links, not in logs.
          metadata: { chainId: m.chainId },
          requestId: req.id,
          ipHash: hashIp(req.ip),
        });
        return { address: m.address.toLowerCase(), chainId: m.chainId };
      } catch (err) {
        if (err instanceof WalletAuthError) {
          await writeSystemAudit(app.deps.pool, null, {
            actorType: "user",
            actorUserId: userId,
            action: "wallet.link_rejected",
            outcome: "denied",
            metadata: { reason: err.code },
            requestId: req.id,
            ipHash: hashIp(req.ip),
          }).catch(() => undefined);
          throw new HttpError(400, "wallet_verification_failed", err.message);
        }
        if (err instanceof Error && err.message.includes("already linked")) {
          throw new HttpError(409, "wallet_already_linked", "this wallet is linked to another account");
        }
        throw err;
      }
    },
  );

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
