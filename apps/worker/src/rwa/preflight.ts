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

export type PreflightResult = "skipped" | "passed" | "failed";

/** A valid address that is not an asset: enough to tell "method not found" from "asset not found". */
const NOT_AN_ASSET = "11111111111111111111111111111111";

/** Whether the preflight applies: opted in, an RPC URL set, and still no signer. */
export function preflightWanted(env: WorkerEnv): boolean {
  return env.RWA_PREFLIGHT_ENABLED && Boolean(env.RWA_SOLANA_RPC_URL) && !env.RWA_SOLANA_SIGNER_SECRET;
}

export async function runSolanaPreflight(env: WorkerEnv, d: PreflightDeps): Promise<PreflightResult> {
  if (!preflightWanted(env)) return "skipped";
  const network = env.RWA_SOLANA_NETWORK;
  let ok = true;
  const cluster = async (url: string, label: string) => {
    try {
      await d.verifyCluster({ url, network, label, attempts: 2 });
      d.log.info({ label, network, genesisHash: (SOLANA_GENESIS_HASHES as Record<string, string>)[network] }, `RWA preflight: ${label} serves ${network}`);
      return true;
    } catch (err) {
      ok = false;
      const e = err instanceof ClusterVerificationError ? { reason: err.reason, endpoint: err.endpoint, detail: err.message } : { reason: "unexpected" };
      d.log.warn({ label, network, ...e }, `RWA preflight: ${label} endpoint failed its cluster check`);
      return false;
    }
  };
  try {
    await cluster(env.RWA_SOLANA_RPC_URL!, "RPC");
    if (!env.RWA_SOLANA_DAS_URL) {
      d.log.info({}, "RWA preflight: no DAS endpoint set; compressed NFTs would stay off");
    } else if (await cluster(env.RWA_SOLANA_DAS_URL, "DAS")) {
      for (const method of ["getAsset", "getAssetProof"]) {
        const p = await d.probeMethod({ url: env.RWA_SOLANA_DAS_URL, method, params: { id: NOT_AN_ASSET } });
        if (p.result === "available") d.log.info({ label: "DAS", method, endpoint: p.endpoint, detail: p.detail ?? null }, `RWA preflight: DAS knows ${method}`);
        else {
          ok = false;
          d.log.warn({ label: "DAS", method, result: p.result, endpoint: p.endpoint, detail: p.detail ?? null }, `RWA preflight: DAS ${method} is ${p.result === "not_found" ? "not supported" : "unavailable"}`);
        }
      }
    }
  } catch {
    // The probes never throw; this only guards the worker against the unexpected.
    ok = false;
  }
  d.log.info({ result: ok ? "passed" : "failed" }, ok ? "RWA preflight passed (read-only; execution stays off until a signer is set)" : "RWA preflight failed; execution stays off");
  return ok ? "passed" : "failed";
}
