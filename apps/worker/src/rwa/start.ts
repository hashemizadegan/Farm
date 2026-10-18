/** Runs the RWA execution engine every few seconds when issuance is configured. */
import { SolanaObservationAdapter, SolanaToken2022Adapter, httpSolanaRpc, localEd25519Signer } from "@metafarm/chain";
import type { WorkerEnv } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { runTick, type Rails } from "./engine";

export function startRwaEngine(env: WorkerEnv, pool: Pool, logger: Logger, intervalMs = 10_000) {
  if (!env.RWA_SOLANA_RPC_URL || !env.RWA_SOLANA_SIGNER_SECRET) {
    logger.info("RWA execution is off (no Solana RPC or signer configured)");
    return undefined;
  }
  const network = env.RWA_SOLANA_NETWORK;
  const signer = localEd25519Signer(env.RWA_SOLANA_SIGNER_SECRET, network);
  if (env.RWA_SOLANA_ISSUER && env.RWA_SOLANA_ISSUER !== signer.address) throw new Error("RWA_SOLANA_ISSUER does not match the signing key");
  const rpc = httpSolanaRpc(env.RWA_SOLANA_RPC_URL);
  const rails: Rails = {
    solana: {
      network,
      issuance: new SolanaToken2022Adapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
      observer: new SolanaObservationAdapter({ network, rpc }),
    },
  };
  const deps = {
    pool,
    rails,
    policy: { screeningMaxAgeDays: env.RWA_SCREENING_MAX_AGE_DAYS, blockedJurisdictions: env.RWA_BLOCKED_JURISDICTIONS },
    mainnetEnabled: env.RWA_MAINNET_ENABLED,
    now: () => new Date(),
    log: logger,
  };
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = runTick(deps)
      .then((s) => {
        if (s.started || s.attempts || s.moves) logger.info(s, "RWA execution");
      })
      .catch((err: unknown) => logger.error({ err }, "RWA execution tick failed"))
      .finally(() => (running = undefined));
  }, intervalMs);
  logger.info({ network, issuer: signer.address }, "RWA execution started");
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
