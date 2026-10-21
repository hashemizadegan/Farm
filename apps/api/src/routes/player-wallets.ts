/**
 * J8: player wallets. A signed-in user links a Solana wallet to their platform (game) identity by
 * signing a one-time message in their own wallet; the API checks the signature. The platform holds no
 * key and signs nothing, and the message authorises no transaction.
 *
 * This is not an RWA party-wallet association (`/rwa/parties/{id}/wallets`), and nothing here creates,
 * reads or implies one. Off unless PLAYER_WALLETS_ENABLED: every route then answers 404.
 */
import type { FastifyInstance } from "fastify";
import { buildPlayerWalletLinkMessage, isSolanaAddress, verifyPlayerWalletSignature } from "@metafarm/chain";
import { PlayerWalletTakenError, linkPlayerWallet, listPlayerWallets, storePlayerWalletChallenge, takePlayerWalletChallenge, unlinkPlayerWallet, writeSystemAudit, type PlayerWalletRow } from "@metafarm/db";
import { generateNonce } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, hashIp, parse } from "../lib/http";

const address = z.string().min(32).max(44).refine(isSolanaAddress, "not a Solana address");
const signature = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/, "a base64 Ed25519 signature (64 bytes)")
  .transform((s) => new Uint8Array(Buffer.from(s, "base64")));

const toWallet = (w: PlayerWalletRow) => ({ chain: w.chain, address: w.address, linkedAt: w.linked_at.toISOString() });

export async function playerWalletRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const enabled = () => {
    if (!env.PLAYER_WALLETS_ENABLED) throw new HttpError(404, "not_found", "route not found");
  };
  const limited = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get("/v1/me/player-wallets", async (req) => {
    enabled();
    await app.authenticate(req);
    return { items: (await listPlayerWallets(app.deps.pool, req.user!.id)).map(toWallet) };
  });

  app.post("/v1/me/player-wallets/challenge", limited, async (req) => {
    enabled();
    await app.authenticate(req);
    const body = parse(z.object({ address }).strict(), req.body);
    const issuedAt = app.deps.now();
    const expiresAt = new Date(issuedAt.getTime() + env.WALLET_NONCE_TTL_SECONDS * 1000);
    const nonce = generateNonce();
    const message = buildPlayerWalletLinkMessage({ domain: env.WALLET_AUTH_DOMAIN, uri: env.WALLET_AUTH_URI, address: body.address, nonce, issuedAt, expiresAt });
    await storePlayerWalletChallenge(app.deps.pool, { userId: req.user!.id, address: body.address, nonce, message, expiresAt });
    return { address: body.address, message, expiresAt: expiresAt.toISOString() };
  });

  app.post("/v1/me/player-wallets", limited, async (req, reply) => {
    enabled();
    await app.authenticate(req);
    const body = parse(z.object({ address, signature }).strict(), req.body);
    const userId = req.user!.id;
    const audit = (action: string, outcome: "success" | "denied", metadata: Record<string, unknown>) =>
      // The address-to-user mapping lives in player_wallets, not in the audit log.
      writeSystemAudit(app.deps.pool, null, { actorType: "user", actorUserId: userId, action, outcome, targetType: "player_wallet", metadata: { chain: "solana", ...metadata }, requestId: req.id, ipHash: hashIp(req.ip) });

    // Single use: the challenge is gone after this, whatever the signature turns out to be.
    const challenge = await takePlayerWalletChallenge(app.deps.pool, userId, body.address, app.deps.now());
    if (!challenge) {
      await audit("player_wallet.link_rejected", "denied", { reason: "no_challenge" }).catch(() => undefined);
      throw new HttpError(400, "player_wallet_challenge_missing", "no current challenge for this wallet; request a new one");
    }
    if (!verifyPlayerWalletSignature(challenge.message, body.address, body.signature)) {
      await audit("player_wallet.link_rejected", "denied", { reason: "bad_signature" }).catch(() => undefined);
      throw new HttpError(400, "player_wallet_verification_failed", "the signature does not match this wallet and challenge");
    }
    try {
      const { row, created } = await linkPlayerWallet(app.deps.pool, userId, body.address);
      await audit("player_wallet.linked", "success", { created });
      return reply.status(created ? 201 : 200).send(toWallet(row));
    } catch (err) {
      if (err instanceof PlayerWalletTakenError) {
        await audit("player_wallet.link_rejected", "denied", { reason: "linked_to_another_account" }).catch(() => undefined);
        throw new HttpError(409, "player_wallet_already_linked", "this wallet is linked to another account");
      }
      throw err;
    }
  });

  app.delete("/v1/me/player-wallets/:address", async (req, reply) => {
    enabled();
    await app.authenticate(req);
    const params = parse(z.object({ address }), req.params);
    if (!(await unlinkPlayerWallet(app.deps.pool, req.user!.id, params.address))) throw new HttpError(404, "not_found", "no such player wallet");
    await writeSystemAudit(app.deps.pool, null, { actorType: "user", actorUserId: req.user!.id, action: "player_wallet.unlinked", targetType: "player_wallet", metadata: { chain: "solana" }, requestId: req.id, ipHash: hashIp(req.ip) });
    return reply.status(204).send();
  });
}
