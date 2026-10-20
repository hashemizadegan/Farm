/**
 * Opt-in, read-only preflight of the Solana endpoints while no signer is set
 * (RWA_PREFLIGHT_ENABLED=true): does the RPC serve the configured cluster, does the DAS endpoint,
 * and does DAS know getAsset and getAssetProof. It cannot sign (there is no key), never throws and
 * never stops the worker; it only logs status lines naming endpoints by scheme and host.
 * A method that exists is not proof that assets and proofs can be retrieved; only a real mint shows that.
 */
import { ClusterVerificationError, SOLANA_GENESIS_HASHES, type ClusterCheck, type MethodProbe } from "@metafarm/chain";
import type { WorkerEnv } from "@metafarm/config";

export interface PreflightDeps {
  verifyCluster: (c: Pick<ClusterCheck, "url" | "network" | "label" | "attempts">) => Promise<void>;
  probeMethod: (c: { url: string; method: string; params: unknown }) => Promise<MethodProbe>;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

/**
 * - `passed`: both endpoints serve the configured cluster and DAS clearly recognizes both methods.
 *   Even then, retrieving a real asset or proof is not proven until a real mint.
 * - `inconclusive`: clusters verified, but a method answer was not clear (auth, limits, plan,
 *   generic errors such as -32000 alone, transport errors).
 * - `failed`: a cluster check failed, or DAS clearly does not support a method.
 */
export type PreflightResult = "skipped" | "passed" | "inconclusive" | "failed";

/** A valid address that is not an asset: enough to tell "method not found" from "asset not found". */
const NOT_AN_ASSET = "11111111111111111111111111111111";

/** Whether the preflight applies: opted in, an RPC URL set, and still no signer. */
export function preflightWanted(env: WorkerEnv): boolean {
  return env.RWA_PREFLIGHT_ENABLED && Boolean(env.RWA_SOLANA_RPC_URL) && !env.RWA_SOLANA_SIGNER_SECRET;
}

export async function runSolanaPreflight(env: WorkerEnv, d: PreflightDeps): Promise<PreflightResult> {
  if (!preflightWanted(env)) return "skipped";
  const network = env.RWA_SOLANA_NETWORK;
  let clustersOk = true;
  const methods: { method: string; outcome: MethodProbe["outcome"] }[] = [];
  const cluster = async (url: string, label: string) => {
    try {
      await d.verifyCluster({ url, network, label, attempts: 2 });
      d.log.info({ label, network, genesisHash: (SOLANA_GENESIS_HASHES as Record<string, string>)[network] }, `RWA preflight: ${label} serves ${network}`);
      return true;
    } catch (err) {
      clustersOk = false;
      const e = err instanceof ClusterVerificationError ? { reason: err.reason, endpoint: err.endpoint, detail: err.message } : { reason: "unexpected" };
      d.log.warn({ label, network, ...e }, `RWA preflight: ${label} endpoint failed its cluster check`);
      return false;
    }
  };
  try {
    const rpcOk = await cluster(env.RWA_SOLANA_RPC_URL!, "RPC");
    const dasOk = env.RWA_SOLANA_DAS_URL ? await cluster(env.RWA_SOLANA_DAS_URL, "DAS") : false;
    if (!env.RWA_SOLANA_DAS_URL) d.log.info({}, "RWA preflight: no DAS endpoint set; compressed NFTs would stay off");
    d.log.info(
      { rpc: rpcOk ? "verified" : "failed", das: env.RWA_SOLANA_DAS_URL ? (dasOk ? "verified" : "failed") : "not set", network },
      clustersOk && dasOk ? `RWA preflight: clusters verified (RPC and DAS serve ${network})` : "RWA preflight: cluster verification incomplete",
    );
    if (dasOk) {
      for (const method of ["getAsset", "getAssetProof"]) {
        const p = await d.probeMethod({ url: env.RWA_SOLANA_DAS_URL!, method, params: { id: NOT_AN_ASSET } });
        methods.push({ method, outcome: p.outcome });
        const fields = { label: "DAS", method, outcome: p.outcome, category: p.category ?? null, detail: p.detail, endpoint: p.endpoint };
        if (p.outcome === "recognized") d.log.info(fields, `RWA preflight: DAS recognizes ${method} (retrieval not proven)`);
        else if (p.outcome === "not_supported") d.log.warn(fields, `RWA preflight: DAS does not support ${method}`);
        else d.log.warn(fields, `RWA preflight: DAS ${method} support inconclusive (${p.category ?? "unknown"})`);
      }
    }
  } catch {
    // The probes never throw; this only guards the worker against the unexpected.
    clustersOk = false;
  }

  const allRecognized = methods.length === 2 && methods.every((m) => m.outcome === "recognized");
  const anyUnsupported = methods.some((m) => m.outcome === "not_supported");
  const dasConfigured = Boolean(env.RWA_SOLANA_DAS_URL);
  let result: PreflightResult;
  if (!clustersOk || anyUnsupported) result = "failed";
  else if (!dasConfigured) result = "passed"; // RPC only: nothing about DAS to establish
  else result = allRecognized ? "passed" : "inconclusive";

  const summary = {
    passed: dasConfigured
      ? `RWA preflight passed: clusters verified, DAS methods recognized; asset and proof retrieval not yet proven (read-only; execution stays off until a signer is set)`
      : `RWA preflight passed: RPC cluster verified; no DAS endpoint (read-only; execution stays off until a signer is set)`,
    inconclusive: "RWA preflight inconclusive: clusters verified, DAS method support not established; execution stays off",
    failed: "RWA preflight failed; execution stays off",
  }[result];
  if (result === "passed") d.log.info({ result }, summary);
  else d.log.warn({ result }, summary);
  return result;
}
