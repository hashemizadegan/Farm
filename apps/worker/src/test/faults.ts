/**
 * Fault injection for the RWA engine: wrappers around the chain ports that misreport what happened,
 * so the engine's safeguards can be exercised end to end.
 *
 * - F1 "expired but landed": the transaction is sent and lands, but observation reports `expired`.
 *   The engine must read the tree on chain, keep the leaf position, never mint again, and open a case.
 * - F2b "wrong proof": DAS shows the right asset, but its proof carries another leaf hash.
 *   The engine must never activate the leaf, and must open an `asset_mismatch` case.
 *
 * Test and local use only. Nothing here is reachable from a deployed service:
 * - the worker's entry point never imports this module (a test checks), and the image ships only
 *   the bundle built from that entry point (Dockerfile copies apps/worker/dist);
 * - there is no environment variable or route that turns it on;
 * - every wrapper refuses to be built outside the test runner or an explicit local drill, and
 *   always in staging or production.
 */
import type { ChainObservationPort, CompressedAssetPort, CompressedAssetProof } from "@metafarm/domain";

/** Throws unless running under the test runner or an explicit local drill, and never when deployed. */
export function assertFaultInjectionAllowed(env: Record<string, string | undefined> = process.env): void {
  const appEnv = env.APP_ENV ?? "development";
  if (appEnv === "staging" || appEnv === "production" || env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) {
    throw new Error("fault injection is refused in deployed environments");
  }
  if (!env.VITEST && env.METAFARM_FAULT_DRILL !== "local") {
    throw new Error("fault injection runs only under the test runner or a local drill (METAFARM_FAULT_DRILL=local)");
  }
}

/** F1: the wrapped observer reports `expired` for the chosen transactions, whatever really happened. */
export function withExpiredObservations(
  inner: ChainObservationPort,
  choose: (txRef: string) => boolean,
  env?: Record<string, string | undefined>,
): ChainObservationPort & { readonly misreported: ReadonlySet<string> } {
  assertFaultInjectionAllowed(env);
  const misreported = new Set<string>();
  return {
    misreported,
    // Sending is untouched: the transaction really goes out and may land.
    submit: (p) => inner.submit(p),
    observe: async (t) => {
      if (misreported.has(t.txRef) || choose(t.txRef)) {
        misreported.add(t.txRef);
        return { status: "expired" };
      }
      return inner.observe(t);
    },
  };
}

/** Picks the first `n` distinct transactions it is asked about, then no more. */
export function firstTransactions(n: number, only: (txRef: string) => boolean = () => true): (txRef: string) => boolean {
  const picked = new Set<string>();
  return (txRef) => {
    if (picked.has(txRef)) return true;
    if (picked.size >= n || !only(txRef)) return false;
    picked.add(txRef);
    return true;
  };
}

/** F2b: the wrapped DAS returns proofs whose leaf hash is replaced for the chosen assets. */
export function withWrongProofs(
  inner: CompressedAssetPort,
  choose: (assetId: string) => boolean,
  wrongLeaf: (proof: CompressedAssetProof) => string = flipLastChar,
  env?: Record<string, string | undefined>,
): CompressedAssetPort & { readonly corrupted: ReadonlySet<string> } {
  assertFaultInjectionAllowed(env);
  const corrupted = new Set<string>();
  return {
    corrupted,
    getAsset: (n, id) => inner.getAsset(n, id),
    getAssetProof: async (n, id) => {
      const proof = await inner.getAssetProof(n, id);
      if (!choose(id)) return proof;
      corrupted.add(id);
      return { ...proof, leaf: wrongLeaf(proof) };
    },
  };
}

/** Another valid-looking base58 leaf hash: the same string with its last character changed. */
function flipLastChar(p: CompressedAssetProof): string {
  const last = p.leaf.at(-1) ?? "1";
  return p.leaf.slice(0, -1) + (last === "2" ? "3" : "2");
}
