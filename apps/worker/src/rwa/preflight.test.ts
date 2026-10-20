/** The opt-in, read-only Solana endpoint preflight: off by default, never signs, never throws, never leaks a URL. */
import { describe, expect, it } from "vitest";
import { ClusterVerificationError, base58Encode, redactEndpoint, type MethodProbe } from "@metafarm/chain";
import { workerEnvSchema } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { preflightWanted, runSolanaPreflight, type PreflightDeps } from "./preflight";
import { startRwaEngine, type RailChecks } from "./start";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
// Made-up credentials: they must never appear in anything logged.
const CRED = "cred-not-real-9012";
const RPC = `https://rpc.devnet.invalid/v2/${CRED}`;
const DAS = `https://das.devnet.invalid/?api-key=${CRED}`;
const TEST_SEED = base58Encode(new Uint8Array(32).fill(7)); // fixed public test seed, never a real key
const env = (o: Record<string, string>) => workerEnvSchema.parse({ ...base, ...o });

type Outcome = "ok" | "mismatch" | "unavailable" | "boom";
type Probe = Pick<MethodProbe, "outcome" | "category" | "detail">;
const RECOGNIZED: Probe = { outcome: "recognized", category: "asset_not_found", detail: "rpc -32000" };
const GENERIC_32000: Probe = { outcome: "inconclusive", category: "unknown", detail: "rpc -32000" };
function deps(o: { RPC?: Outcome; DAS?: Outcome; methods?: Partial<Record<string, Probe>> } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const d: PreflightDeps = {
    verifyCluster: async ({ url, label }) => {
      calls.push(`genesis:${label}`);
      const r = o[label as "RPC" | "DAS"] ?? "ok";
      if (r === "ok") return;
      if (r === "boom") throw new Error(`socket hang up ${url}`);
      throw new ClusterVerificationError(r, redactEndpoint(url), `${label} endpoint ${redactEndpoint(url)}: ${r}`);
    },
    probeMethod: async ({ url, method }) => {
      calls.push(`probe:${method}`);
      return { method, endpoint: redactEndpoint(url), ...(o.methods?.[method] ?? RECOGNIZED) };
    },
    log: { info: (x, m) => void lines.push(`${m} ${JSON.stringify(x)}`), warn: (x, m) => void lines.push(`WARN ${m} ${JSON.stringify(x)}`) },
  };
  return { d, calls, lines };
}
const both = () => env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS });

describe("Solana endpoint preflight", () => {
  it("is off by default, and off whenever a signer is set", () => {
    expect(workerEnvSchema.parse(base).RWA_PREFLIGHT_ENABLED).toBe(false);
    expect(preflightWanted(env({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }))).toBe(false);
    expect(preflightWanted(env({ RWA_PREFLIGHT_ENABLED: "true" }))).toBe(false); // no RPC URL
    expect(preflightWanted(env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_SIGNER_SECRET: TEST_SEED }))).toBe(false);
    expect(preflightWanted(env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC }))).toBe(true);
  });

  it("makes no call at all when not wanted", async () => {
    for (const e of [env({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }), env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS, RWA_SOLANA_SIGNER_SECRET: TEST_SEED })]) {
      const k = deps();
      expect(await runSolanaPreflight(e, k.d)).toBe("skipped");
      expect(k.calls).toEqual([]);
    }
  });

  it("passes only when both clusters are verified and DAS clearly recognizes both methods, saying retrieval is unproven", async () => {
    const k = deps();
    expect(await runSolanaPreflight(both(), k.d)).toBe("passed");
    expect(k.calls).toEqual(["genesis:RPC", "genesis:DAS", "probe:getAsset", "probe:getAssetProof"]);
    const out = k.lines.join("\n");
    expect(out).toContain("RWA preflight: clusters verified (RPC and DAS serve solana-devnet)");
    expect(out).toContain("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(out).toContain("RWA preflight: DAS recognizes getAsset (retrieval not proven)");
    expect(out).toContain("asset and proof retrieval not yet proven");
    expect(out).not.toContain(CRED);
  });

  it("is inconclusive, never 'passed', when a method answer is unclear (e.g. -32000 alone, auth, rate or plan limits)", async () => {
    const unclear: Probe[] = [
      GENERIC_32000,
      { outcome: "inconclusive", category: "unauthorized", detail: "http 401" },
      { outcome: "inconclusive", category: "rate_limited", detail: "http 429" },
      { outcome: "inconclusive", category: "plan_restricted", detail: "rpc -32000" },
      { outcome: "inconclusive", category: "unknown", detail: "timeout" },
    ];
    for (const p of unclear) {
      for (const method of ["getAsset", "getAssetProof"]) {
        const k = deps({ methods: { [method]: p } });
        expect(await runSolanaPreflight(both(), k.d)).toBe("inconclusive");
        const out = k.lines.join("\n");
        expect(out).toContain("RWA preflight: clusters verified");
        expect(out).toContain(`DAS ${method} support inconclusive (${p.category})`);
        expect(out).toContain("RWA preflight inconclusive: clusters verified, DAS method support not established; execution stays off");
        expect(out).not.toContain("preflight passed");
        expect(out).not.toContain(CRED);
      }
    }
    // Exactly what staging showed: both methods answered -32000 with no clear message.
    const k = deps({ methods: { getAsset: GENERIC_32000, getAssetProof: GENERIC_32000 } });
    expect(await runSolanaPreflight(both(), k.d)).toBe("inconclusive");
  });

  it("fails on a cluster failure or a method DAS clearly does not support, never throwing or leaking a URL", async () => {
    const cases: Parameters<typeof deps>[0][] = [
      { RPC: "mismatch" },
      { RPC: "unavailable" },
      { RPC: "boom" },
      { DAS: "mismatch" },
      { DAS: "unavailable" },
      { methods: { getAsset: { outcome: "not_supported", category: "method_not_found", detail: "rpc -32601" } } },
    ];
    for (const c of cases) {
      const k = deps(c);
      expect(await runSolanaPreflight(both(), k.d)).toBe("failed");
      const out = k.lines.join("\n");
      expect(out).toContain("RWA preflight failed; execution stays off");
      expect(out).not.toContain("preflight passed");
      expect(out).not.toContain(CRED);
    }
    // Cluster results are reported separately from method support, and a DAS endpoint on the
    // wrong cluster is not probed at all.
    const wrong = deps({ DAS: "mismatch" });
    await runSolanaPreflight(both(), wrong.d);
    expect(wrong.calls).toEqual(["genesis:RPC", "genesis:DAS"]);
    expect(wrong.lines.join("\n")).toContain("cluster verification incomplete");
  });

  it("says so when no DAS endpoint is set", async () => {
    const k = deps();
    expect(await runSolanaPreflight(env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC }), k.d)).toBe("passed");
    expect(k.calls).toEqual(["genesis:RPC"]);
    expect(k.lines.join("\n")).toContain("no DAS endpoint set");
    expect(k.lines.join("\n")).toContain("RPC cluster verified; no DAS endpoint");
  });
});

describe("RWA engine start with the preflight", () => {
  const untouchable = new Proxy({}, { get: () => { throw new Error("the pool was used"); } }) as unknown as Pool;
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
  const noRails: RailChecks = { verifyCluster: async () => { throw new Error("no rail check expected"); }, log: { warn: () => undefined, error: () => undefined } };

  it("keeps execution off and calls nothing when the preflight is off", async () => {
    const k = deps();
    expect(await startRwaEngine(env({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }), untouchable, quiet, 5, noRails, k.d)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(k.calls).toEqual([]);
  });

  it("runs the preflight but still starts no engine when it is on", async () => {
    const k = deps({ RPC: "unavailable" });
    expect(await startRwaEngine(env({ RWA_PREFLIGHT_ENABLED: "true", RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }), untouchable, quiet, 5, noRails, k.d)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(k.calls[0]).toBe("genesis:RPC");
    expect(k.lines.join("\n")).toContain("execution stays off");
  });
  it("with the real clients and the flag off, never touches the network", async () => {
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("no network expected");
    }) as typeof fetch;
    try {
      // No injected checks: the production code paths, with RPC and DAS URLs set but no signer.
      expect(await startRwaEngine(env({ RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }), untouchable, quiet, 5)).toBeUndefined();
      await new Promise((r) => setTimeout(r, 30));
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
