/**
 * Which rails the worker builds from its settings. Solana rails exist only after their endpoints
 * prove their cluster; compressed NFTs stay off unless fully configured and verified.
 */
import { describe, expect, it } from "vitest";
import { ClusterVerificationError, base58Encode, localEd25519Signer, localTronSigner, redactEndpoint } from "@metafarm/chain";
import { workerEnvSchema } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { Logger } from "@metafarm/observability";
import { buildRails, startRwaEngine, type RailChecks } from "./start";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
// Fixed, publicly known test seeds (all 7s); never real keys.
const TEST_SEED = base58Encode(new Uint8Array(32).fill(7));
const TRON_TEST_KEY = "07".repeat(32);
// Made-up provider credentials: they must never show up in anything logged or thrown.
const CRED = "cred-not-real-1234";
const RPC = `https://rpc.devnet.invalid/v1/${CRED}?api-key=${CRED}`;
const DAS = `https://das.devnet.invalid/?api-key=${CRED}`;
const env = (o: Record<string, string>) => workerEnvSchema.parse({ ...base, ...o });
const SOLANA = { RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_SIGNER_SECRET: TEST_SEED };

type Outcome = "ok" | "mismatch" | "invalid_response" | "unavailable" | "boom";
/** Cluster checks with a scripted outcome per endpoint label, recording calls and log lines. */
function checks(outcomes: Partial<Record<"RPC" | "DAS", Outcome>> = {}) {
  const calls: { label: string; network: string; url: string }[] = [];
  const logged: string[] = [];
  const c: RailChecks = {
    verifyCluster: async ({ url, network, label }) => {
      calls.push({ label, network, url });
      const o = outcomes[label as "RPC" | "DAS"] ?? "ok";
      if (o === "ok") return;
      if (o === "boom") throw new Error(`socket hang up ${url}`);
      throw new ClusterVerificationError(o, redactEndpoint(url), `${label} endpoint ${redactEndpoint(url)}: ${o}`);
    },
    log: {
      warn: (obj, m) => void logged.push(JSON.stringify(obj) + m),
      error: (obj, m) => void logged.push(JSON.stringify(obj) + m),
    },
  };
  return { c, calls, logged };
}
async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure");
}

describe("RWA rails from settings", () => {
  it("builds nothing, and calls no endpoint, without a signer", async () => {
    const unsigned: Record<string, string>[] = [{}, { RWA_SOLANA_RPC_URL: RPC, RWA_SOLANA_DAS_URL: DAS }, { RWA_SOLANA_SIGNER_SECRET: TEST_SEED, RWA_SOLANA_DAS_URL: DAS }];
    for (const o of unsigned) {
      const k = checks();
      expect(await buildRails(env(o), k.c)).toEqual({});
      expect(k.calls).toHaveLength(0);
    }
  });

  it("builds the Solana rail once the RPC endpoint proves it serves devnet", async () => {
    const k = checks();
    const r = await buildRails(env(SOLANA), k.c);
    expect(k.calls).toEqual([{ label: "RPC", network: "solana-devnet", url: RPC }]);
    expect(r.solana?.network).toBe("solana-devnet");
    expect(r.solana?.issuance).toBeDefined();
    // No DAS URL: compressed NFTs stay off and no DAS check is made.
    expect(r.solana?.compressed).toBeUndefined();
    expect(r.tron).toBeUndefined();
  });

  it("refuses to start when the RPC endpoint serves another cluster or is not a Solana endpoint", async () => {
    for (const o of ["mismatch", "invalid_response"] as const) {
      const k = checks({ RPC: o });
      const e = await thrown(buildRails(env({ ...SOLANA, RWA_SOLANA_DAS_URL: DAS }), k.c));
      expect(e.message).toMatch(/^refusing to start: RPC endpoint/);
      expect(e.message).not.toContain(CRED);
      // Stopped before the DAS endpoint was even asked.
      expect(k.calls.map((c) => c.label)).toEqual(["RPC"]);
    }
  });

  it("leaves Solana off when the RPC endpoint cannot be verified, without logging its URL", async () => {
    for (const o of ["unavailable", "boom"] as const) {
      const k = checks({ RPC: o });
      const r = await buildRails(env({ ...SOLANA, RWA_SOLANA_DAS_URL: DAS }), k.c);
      expect(r.solana).toBeUndefined();
      expect(k.calls.map((c) => c.label)).toEqual(["RPC"]);
      expect(k.logged.join("\n")).toContain("Solana execution is off");
      expect(k.logged.join("\n")).not.toContain(CRED);
    }
  });

  it("turns compressed NFTs on only when the DAS endpoint proves the same cluster", async () => {
    const k = checks();
    const r = await buildRails(env({ ...SOLANA, RWA_SOLANA_DAS_URL: DAS, RWA_CNFT_TREE_CAPACITY: "1000" }), k.c);
    expect(k.calls.map((c) => [c.label, c.network])).toEqual([
      ["RPC", "solana-devnet"],
      ["DAS", "solana-devnet"],
    ]);
    const c = r.solana?.compressed;
    expect(c).toBeDefined();
    expect(c!.creator).toBe(localEd25519Signer(TEST_SEED, "solana-devnet").address);
    expect(c!.treeShape.capacity).toBeGreaterThanOrEqual(1000);
  });

  it("refuses to start on a DAS endpoint of another cluster; keeps compressed NFTs off when DAS cannot be verified", async () => {
    const wrong = checks({ DAS: "mismatch" });
    const e = await thrown(buildRails(env({ ...SOLANA, RWA_SOLANA_DAS_URL: DAS }), wrong.c));
    expect(e.message).toMatch(/^refusing to start: DAS endpoint/);
    expect(e.message).not.toContain(CRED);

    for (const o of ["unavailable", "boom"] as const) {
      const k = checks({ DAS: o });
      const r = await buildRails(env({ ...SOLANA, RWA_SOLANA_DAS_URL: DAS }), k.c);
      expect(r.solana).toBeDefined();
      expect(r.solana?.compressed).toBeUndefined();
      expect(k.logged.join("\n")).toContain("compressed NFTs are off");
      expect(k.logged.join("\n")).not.toContain(CRED);
    }
  });

  it("keeps the local key checks: mainnet keys and a mismatched issuer are refused before any network call", async () => {
    const mainnet = checks();
    expect((await thrown(buildRails(env({ ...SOLANA, RWA_SOLANA_NETWORK: "solana-mainnet" }), mainnet.c))).message).toMatch(/refused on solana-mainnet/);
    expect(mainnet.calls).toHaveLength(0);
    const issuer = checks();
    const other = base58Encode(new Uint8Array(32).fill(9));
    expect((await thrown(buildRails(env({ ...SOLANA, RWA_SOLANA_ISSUER: other }), issuer.c))).message).toBe("RWA_SOLANA_ISSUER does not match the signing key");
    expect(issuer.calls).toHaveLength(0);
    // And mainnet with RWA_MAINNET_ENABLED is refused by the settings themselves.
    expect(workerEnvSchema.safeParse({ ...base, ...SOLANA, RWA_MAINNET_ENABLED: "true" }).success).toBe(false);
  });

  it("builds the TRON rail as before, with no Solana check", async () => {
    const treasury = localTronSigner(TRON_TEST_KEY, "tron-nile").address;
    const k = checks();
    const r = await buildRails(env({ RWA_TRON_API_URL: "https://nile.invalid", RWA_TRON_SIGNER_PRIVATE_KEY: TRON_TEST_KEY, RWA_TRON_TREASURY: treasury }), k.c);
    expect(r.tron).toMatchObject({ network: "tron-nile", treasury });
    expect(r.solana).toBeUndefined();
    expect(k.calls).toHaveLength(0);
    // A Solana endpoint that cannot be verified leaves TRON running.
    const both = await buildRails(
      env({ ...SOLANA, RWA_TRON_API_URL: "https://nile.invalid", RWA_TRON_SIGNER_PRIVATE_KEY: TRON_TEST_KEY, RWA_TRON_TREASURY: treasury }),
      checks({ RPC: "unavailable" }).c,
    );
    expect(both.solana).toBeUndefined();
    expect(both.tron).toBeDefined();
  });

  it("parses the compressed NFT settings as optional, with a bounded tree capacity", () => {
    const e = workerEnvSchema.parse(base);
    expect(e.RWA_SOLANA_DAS_URL).toBeUndefined();
    expect(e.RWA_CNFT_TREE_CAPACITY).toBe(16_384);
    expect(workerEnvSchema.safeParse({ ...base, RWA_CNFT_TREE_CAPACITY: "4" }).success).toBe(false);
    expect(workerEnvSchema.safeParse({ ...base, RWA_SOLANA_DAS_URL: "not a url" }).success).toBe(false);
  });
});

describe("RWA engine start", () => {
  // The engine must not touch the database (or sign anything) before its rails exist.
  const untouchable = new Proxy({}, { get: () => { throw new Error("the pool was used"); } }) as unknown as Pool;
  function logger() {
    const lines: string[] = [];
    const l = { info: (a: unknown, b?: string) => void lines.push(typeof a === "string" ? a : `${JSON.stringify(a)} ${b ?? ""}`), warn: () => undefined, error: () => undefined };
    return { l: l as unknown as Logger, lines };
  }

  it("still reports execution off when no signer is configured", async () => {
    const log = logger();
    expect(await startRwaEngine(env({}), untouchable, log.l, 5, checks().c)).toBeUndefined();
    expect(log.lines).toEqual(["RWA execution is off (no Solana or TRON signer configured)"]);
  });

  it("starts nothing while the cluster check is pending, and nothing when it cannot pass", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const k = checks();
    const started = startRwaEngine(env(SOLANA), untouchable, logger().l, 1, {
      ...k.c,
      verifyCluster: async () => {
        await pending;
        throw new ClusterVerificationError("unavailable", "https://rpc.devnet.invalid/[redacted]", "RPC endpoint could not be verified");
      },
    });
    let settled = false;
    void started.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // no rail and no tick while the check is pending
    release();
    expect(await started).toBeUndefined();
  });
});
