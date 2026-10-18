/** Runs the RWA execution engine every few seconds when at least one rail is configured. */
import {
  SolanaObservationAdapter,
  gcpKmsClient,
  gcpKmsEd25519Signer,
  gcpKmsTronSigner,
  parseServiceAccountKey,
  serviceAccountAuth,
  SolanaToken2022Adapter,
  TronObservationAdapter,
  TronSettlementAdapter,
  httpSolanaRpc,
  httpTron,
  localEd25519Signer,
  localTronSigner,
} from "@metafarm/chain";
import type { WorkerEnv } from "@metafarm/config";
import type { Ed25519Signer, TronSigner } from "@metafarm/domain";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { runTick, type Rails } from "./engine";

/** Signers: Cloud KMS when configured (the only option on mainnets), else testnet keys held as secrets. */
async function signers(env: WorkerEnv): Promise<{ solana?: Ed25519Signer; tron?: TronSigner }> {
  const kms = env.GCP_KMS_CREDENTIALS_JSON ? gcpKmsClient(serviceAccountAuth(parseServiceAccountKey(env.GCP_KMS_CREDENTIALS_JSON))) : undefined;
  const solana = env.RWA_SOLANA_KMS_KEY && kms
    ? await gcpKmsEd25519Signer(kms, env.RWA_SOLANA_KMS_KEY)
    : env.RWA_SOLANA_SIGNER_SECRET
      ? localEd25519Signer(env.RWA_SOLANA_SIGNER_SECRET, env.RWA_SOLANA_NETWORK)
      : undefined;
  const tron = env.RWA_TRON_KMS_KEY && kms
    ? await gcpKmsTronSigner(kms, env.RWA_TRON_KMS_KEY)
    : env.RWA_TRON_SIGNER_PRIVATE_KEY
      ? localTronSigner(env.RWA_TRON_SIGNER_PRIVATE_KEY, env.RWA_TRON_NETWORK)
      : undefined;
  return { solana, tron };
}

export async function buildRails(env: WorkerEnv): Promise<Rails> {
  const rails: Rails = {};
  if (!env.RWA_SOLANA_RPC_URL && !(env.RWA_TRON_API_URL && env.RWA_TRON_TREASURY)) return rails;
  const keys = await signers(env);
  if (env.RWA_SOLANA_RPC_URL && keys.solana) {
    const network = env.RWA_SOLANA_NETWORK;
    const signer = keys.solana;
    if (env.RWA_SOLANA_ISSUER && env.RWA_SOLANA_ISSUER !== signer.address) throw new Error("RWA_SOLANA_ISSUER does not match the signing key");
    const rpc = httpSolanaRpc(env.RWA_SOLANA_RPC_URL);
    rails.solana = {
      network,
      issuance: new SolanaToken2022Adapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
      observer: new SolanaObservationAdapter({ network, rpc }),
    };
  }
  if (env.RWA_TRON_API_URL && env.RWA_TRON_TREASURY && keys.tron) {
    const network = env.RWA_TRON_NETWORK;
    const signer = keys.tron;
    if (signer.address !== env.RWA_TRON_TREASURY) throw new Error("RWA_TRON_TREASURY does not match the signing key");
    const http = httpTron(env.RWA_TRON_API_URL, { apiKey: env.RWA_TRON_API_KEY });
    rails.tron = {
      network,
      treasury: signer.address,
      settlement: new TronSettlementAdapter({ network, http, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxFeeLimitSun: env.RWA_TRON_MAX_FEE_LIMIT_SUN }),
      observer: new TronObservationAdapter({ network, http }),
    };
  }
  return rails;
}

/**
 * Starts the engine once its signers are reachable. A KMS that cannot be reached yet (or a key that
 * does not match its configured address) leaves execution off and is retried every minute; the
 * rest of the worker keeps running either way.
 */
export function startRwaEngine(env: WorkerEnv, pool: Pool, logger: Logger, intervalMs = 10_000, retryMs = 60_000) {
  const policy = { screeningMaxAgeDays: env.RWA_SCREENING_MAX_AGE_DAYS, blockedJurisdictions: env.RWA_BLOCKED_JURISDICTIONS };
  let timer: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closed = false;

  const run = (rails: Rails) => {
    const deps = { pool, rails, policy, mainnetEnabled: env.RWA_MAINNET_ENABLED, now: () => new Date(), log: logger };
    timer = setInterval(() => {
      if (running) return;
      running = runTick(deps)
        .then((s) => {
          if (s.started || s.attempts || s.moves) logger.info(s, "RWA execution");
        })
        .catch((err: unknown) => logger.error({ err }, "RWA execution tick failed"))
        .finally(() => (running = undefined));
    }, intervalMs);
    logger.info({ solana: rails.solana?.network ?? null, tron: rails.tron?.network ?? null, treasury: rails.tron?.treasury ?? null }, "RWA execution started");
  };

  const attempt = () => {
    buildRails(env)
      .then((rails) => {
        if (closed) return;
        if (rails.solana || rails.tron) run(rails);
        else logger.info("RWA execution is off (no Solana or TRON signer configured)");
      })
      .catch((err: unknown) => {
        logger.error({ err }, "RWA signers unavailable; execution stays off and is retried");
        if (!closed) retry = setTimeout(attempt, retryMs);
      });
  };
  attempt();

  return {
    async close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(retry);
      await running;
    },
  };
}
