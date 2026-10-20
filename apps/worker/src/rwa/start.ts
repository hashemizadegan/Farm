/**
 * Runs the RWA execution engine every few seconds when at least one rail is configured.
 *
 * The Solana network setting is only a label: before any Solana rail is built, the RPC endpoint (and,
 * for compressed NFTs, the DAS endpoint) must prove with `getGenesisHash` that it serves that cluster.
 * The engine starts only after these checks, so nothing is signed while they are pending.
 */
import {
  BubblegumAdapter,
  ClusterVerificationError,
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
  probeSolanaMethod,
  verifySolanaCluster,
  type ClusterCheck,
} from "@metafarm/chain";
import type { WorkerEnv } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { runTick, type Rails } from "./engine";
import { preflightWanted, runSolanaPreflight, type PreflightDeps } from "./preflight";

export interface RailChecks {
  /** Resolves when the endpoint serves the configured cluster; throws ClusterVerificationError otherwise. */
  verifyCluster: (c: Pick<ClusterCheck, "url" | "network" | "label">) => Promise<void>;
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

/**
 * Whether an endpoint passed its cluster check. A wrong cluster or a non-Solana answer is a
 * configuration error and stops the worker (as a key that does not match its issuer does); an
 * endpoint that cannot be reached leaves the rail it serves off until the worker restarts.
 */
async function clusterVerified(checks: RailChecks, c: Pick<ClusterCheck, "url" | "network" | "label">, offMeans: string): Promise<boolean> {
  try {
    await checks.verifyCluster(c);
    return true;
  } catch (err) {
    if (err instanceof ClusterVerificationError && err.reason === "unavailable") {
      checks.log.error({ endpoint: err.endpoint, reason: err.reason, err: err.message }, `${offMeans}: the ${c.label} endpoint's cluster could not be verified`);
      return false;
    }
    if (err instanceof ClusterVerificationError) throw new Error(`refusing to start: ${err.message}`);
    // Anything unexpected is treated like an endpoint that could not be verified, without its message (it may hold the URL).
    checks.log.error({ label: c.label }, `${offMeans}: the ${c.label} endpoint's cluster check failed unexpectedly`);
    return false;
  }
}

export async function buildRails(env: WorkerEnv, checks: RailChecks): Promise<Rails> {
  const rails: Rails = {};
  if (env.RWA_SOLANA_RPC_URL && env.RWA_SOLANA_SIGNER_SECRET) {
    const network = env.RWA_SOLANA_NETWORK;
    // Local checks first (no network call): mainnet keys are refused and the issuer must match.
    const signer = localEd25519Signer(env.RWA_SOLANA_SIGNER_SECRET, network);
    if (env.RWA_SOLANA_ISSUER && env.RWA_SOLANA_ISSUER !== signer.address) throw new Error("RWA_SOLANA_ISSUER does not match the signing key");
    if (await clusterVerified(checks, { url: env.RWA_SOLANA_RPC_URL, network, label: "RPC" }, "Solana execution is off")) {
      const rpc = httpSolanaRpc(env.RWA_SOLANA_RPC_URL);
      rails.solana = {
        network,
        issuance: new SolanaToken2022Adapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
        observer: new SolanaObservationAdapter({ network, rpc }),
      };
      // Compressed NFTs (registrations) need a DAS index to confirm leaves; off without one, or
      // until the DAS endpoint proves it serves the same cluster (never assumed from the label).
      if (env.RWA_SOLANA_DAS_URL && (await clusterVerified(checks, { url: env.RWA_SOLANA_DAS_URL, network, label: "DAS" }, "compressed NFTs are off"))) {
        const shape = planTree(env.RWA_CNFT_TREE_CAPACITY);
        rails.solana.compressed = {
          issuance: new BubblegumAdapter({ network, rpc, signer, mainnetEnabled: env.RWA_MAINNET_ENABLED, maxPriorityFeeMicroLamports: env.RWA_SOLANA_MAX_PRIORITY_FEE }),
          assets: new DasCompressedAssetAdapter({ network, dasUrl: env.RWA_SOLANA_DAS_URL, rpc }),
          creator: signer.address,
          treeShape: { maxDepth: shape.maxDepth, maxBufferSize: shape.maxBufferSize, canopyDepth: shape.canopyDepth, capacity: shape.capacity },
        };
      }
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

/** Builds and verifies the rails, then starts the engine; resolves to undefined when no rail is on. */
export async function startRwaEngine(env: WorkerEnv, pool: Pool, logger: Logger, intervalMs = 10_000, checks?: RailChecks, preflight?: PreflightDeps) {
  // Opt-in, read-only, and only while there is no signer: it runs in the background and never throws.
  if (preflightWanted(env)) void runSolanaPreflight(env, preflight ?? { verifyCluster: verifySolanaCluster, probeMethod: probeSolanaMethod, log: logger }).catch(() => undefined);
  const rails = await buildRails(env, checks ?? { verifyCluster: verifySolanaCluster, log: logger });
  if (!rails.solana && !rails.tron) {
    const configured = Boolean(env.RWA_SOLANA_RPC_URL && env.RWA_SOLANA_SIGNER_SECRET) || Boolean(env.RWA_TRON_API_URL && env.RWA_TRON_SIGNER_PRIVATE_KEY && env.RWA_TRON_TREASURY);
    logger.info(configured ? "RWA execution is off (no rail passed its startup checks)" : "RWA execution is off (no Solana or TRON signer configured)");
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
