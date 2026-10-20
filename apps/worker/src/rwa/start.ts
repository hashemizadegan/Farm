/** Runs the RWA execution engine every few seconds when at least one rail is configured. */
import {
  BubblegumAdapter,
  DasCompressedAssetAdapter,
  SolanaObservationAdapter,
  SolanaToken2022Adapter,
  TronObservationAdapter,
  TronSettlementAdapter,
  httpSolanaRpc,
  httpTron,
  localEd25519Signer,
  localTronSigner,
  planTree,
} from "@metafarm/chain";
import type { WorkerEnv } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { runTick, type Rails } from "./engine";

export function buildRails(env: WorkerEnv): Rails {
  const rails: Rails = {};
  if (env.RWA_SOLANA_RPC_URL && env.RWA_SOLANA_SIGNER_SECRET) {
    const network = env.RWA_SOLANA_NETWORK;
    const signer = localEd25519Signer(env.RWA_SOLANA_SIGNER_SECRET, network);
    if (env.RWA_SOLANA_ISSUER && env.RWA_SOLANA_ISSUER !== signer.address) throw new Error("RWA_SOLANA_ISSUER does not match the signing key");
    const rpc = httpSolanaRpc(env.RWA_SOLANA_RPC_URL);
    rails.solana = {
      network,
      issuance: new SolanaToken2022Adapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
      observer: new SolanaObservationAdapter({ network, rpc }),
    };
    // Compressed NFTs (registrations) need a DAS index to confirm leaves; off without one.
    if (env.RWA_SOLANA_DAS_URL) {
      const shape = planTree(env.RWA_CNFT_TREE_CAPACITY);
      rails.solana.compressed = {
        issuance: new BubblegumAdapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
        assets: new DasCompressedAssetAdapter({ network, dasUrl: env.RWA_SOLANA_DAS_URL, rpc }),
        creator: signer.address,
        treeShape: { maxDepth: shape.maxDepth, maxBufferSize: shape.maxBufferSize, canopyDepth: shape.canopyDepth, capacity: shape.capacity },
      };
    }
  }
  if (env.RWA_TRON_API_URL && env.RWA_TRON_SIGNER_PRIVATE_KEY && env.RWA_TRON_TREASURY) {
    const network = env.RWA_TRON_NETWORK;
    const signer = localTronSigner(env.RWA_TRON_SIGNER_PRIVATE_KEY, network);
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

export function startRwaEngine(env: WorkerEnv, pool: Pool, logger: Logger, intervalMs = 10_000) {
  const rails = buildRails(env);
  if (!rails.solana && !rails.tron) {
    logger.info("RWA execution is off (no Solana or TRON signer configured)");
    return undefined;
  }
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
        if (s.started || s.attempts || s.moves || s.confirmed) logger.info(s, "RWA execution");
      })
      .catch((err: unknown) => logger.error({ err }, "RWA execution tick failed"))
      .finally(() => (running = undefined));
  }, intervalMs);
  logger.info(
    {
      solana: rails.solana?.network ?? null,
      compressedNfts: rails.solana?.compressed ? { treeCapacity: rails.solana.compressed.treeShape.capacity } : null,
      tron: rails.tron?.network ?? null,
      treasury: rails.tron?.treasury ?? null,
    },
    "RWA execution started",
  );
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
