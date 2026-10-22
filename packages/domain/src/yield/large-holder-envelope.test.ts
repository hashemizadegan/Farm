/**
 * Performance and memory envelopes for large-holder simulation artifacts (leaf layout 2), without network or
 * storage I/O. To stay stable in CI, the envelopes are deterministic wherever possible:
 * - cost is measured in hash calls (a counting hasher), which are exact for a given input;
 * - proof sizes follow the RFC 9162 definition exactly;
 * - artifact sizes are exact byte counts, pinned for a seeded 4,096-holder cycle;
 * - wall-clock time and heap growth are only capped, generously (an order of magnitude above local runs),
 *   so a slow CI machine cannot fail them while a pathological regression (quadratic work, runaway memory)
 *   still would.
 *
 * To regenerate the C# sample after a deliberate change: write `await largeTreeSampleText()` to
 * clients/unity-starter/Samples/claim-payloads.large-tree.sample.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalYieldArtifact, yieldArtifactHash } from "./artifact";
import { SHA256_RFC9162_HASHER, SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND, buildClaimTree } from "./claim-tree";
import { type ClaimPayloadDto, type ClaimLookupError, type PublishedClaimTree, createClaimLookup, verifyClaimPayload } from "./claim-lookup";
import { type CyclePipelineError, calculateSimulationCycle, cycleArtifactProblems } from "./pipeline";
import { LARGE_REQUEST, countingHasher, largeHolderCycle, largeTreeSampleText, pickParties, rfc9162PathLength, sharedCycle16k } from "./large-holder.test-support";
import { MockOwnershipAdapter, type OwnershipSourceError, loadVerifiedOwnershipSnapshot } from "./ownership-source";

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples/claim-payloads.large-tree.sample.json");

/** Heap in use, where the runtime reports it (Node); 0 elsewhere, which disables the memory caps. */
const heapUsed = (): number => (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process?.memoryUsage().heapUsed ?? 0;
const now = () => globalThis.performance.now();
const MiB = 1024 * 1024;
const ceilLog2 = (n: number) => Math.ceil(Math.log2(n));
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as CyclePipelineError | ClaimLookupError | OwnershipSourceError).code ?? (e as Error).name;
  }
  return "no error";
};

// One run per size, shared by the tests in this file (they run sequentially). The 4,096 run uses a
// counting hasher, so the pipeline's own build-and-verify cost is known exactly.
const SEED = 0xe17e10e5n;
const hasher4k = countingHasher();
let run4k: ReturnType<typeof largeHolderCycle> | undefined;
const cycle4k = () => (run4k ??= largeHolderCycle(4_096, SEED, hasher4k));
// The 16,384-holder cycle uses the shared parameters (SHARED_16K) of the read-model tests; built once per file, deeply frozen.
let run16k: ReturnType<typeof largeHolderCycle> | undefined;
const cycle16k = () => (run16k ??= largeHolderCycle(16_384, SEED)); // DIAGNOSTIC: #79 cycle (dust 0, unfrozen)

// Pinned for the seeded 4,096-holder cycle: any change to the artifact's content or serialization shows here.
const PINNED_4K = { artifactSha256: "3e374c9bf283f1d829430ab9fc3c6ae1356f5c76930872dbb5f4cf7645664a0c", canonicalBytes: 7_487_231, payable: 3_015 };

describe("claim tree build envelope (4,096 and 16,384 holders)", () => {
  const sumPaths: Record<number, number> = {};
  for (const holders of [4_096, 16_384]) {
    it(`${holders} holders: exactly L leaf and L − 1 node hashes, RFC 9162 path lengths, capped time and heap`, async () => {
      const r = await (holders === 4_096 ? cycle4k() : cycle16k());
      const plan = r.artifact.distribution.plan;
      const L = plan.entries.filter((e) => e.state === "payable").length;
      expect(L).toBeGreaterThan(holders / 2);
      const h = countingHasher();
      const heap0 = heapUsed();
      const t0 = now();
      const tree = await buildClaimTree({
        plan,
        policy: SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND,
        hasher: h,
        context: { ...r.input.leafContext, payoutMint: r.input.settlement.mint, ownershipSnapshotHash: r.ownership.snapshotHash },
      });
      const elapsed = now() - t0;
      const heapGrowth = heapUsed() - heap0;
      expect(tree.root).toBe(r.artifact.claimTree!.root);
      expect(tree.size).toBe(L);
      // Deterministic cost: linear in the leaf count.
      expect(h.counts).toEqual({ leaf: L, node: L - 1 });
      // Deterministic proof size: every path has exactly its RFC 9162 length, at most ⌈log2 L⌉.
      let total = 0;
      for (const l of tree.leaves) {
        expect(l.proof.path.length).toBe(rfc9162PathLength(l.leafIndex, L));
        total += l.proof.path.length;
      }
      expect(tree.leaves.reduce((m, l) => Math.max(m, l.proof.path.length), 0)).toBe(ceilLog2(L));
      expect(total).toBeLessThanOrEqual(L * ceilLog2(L));
      sumPaths[holders] = total / L; // average path length
      // Every leaf is 233 bytes; proof material is 32 bytes per path entry.
      expect(tree.leaves.every((l) => l.leafBytes.length === 466)).toBe(true);
      // Caps, not targets (local: ~1 s and < 100 MiB at 16,384 holders).
      expect(elapsed).toBeLessThan(120_000);
      if (heap0 > 0) expect(heapGrowth).toBeLessThan(1_024 * MiB);
    }, 300_000);
  }

  it("proof material grows as L·log L: 4× the holders adds at most log2(4) + 1 to the average path length", () => {
    expect(sumPaths[16_384]! - sumPaths[4_096]!).toBeGreaterThan(0);
    expect(sumPaths[16_384]! - sumPaths[4_096]!).toBeLessThanOrEqual(3);
  });
});

describe("pipeline verification cost (4,096 holders)", () => {
  it("builds and then re-verifies every proof: 2L leaf hashes and (L − 1) + Σ path node hashes, exactly", async () => {
    const r = await cycle4k();
    const leaves = r.artifact.claimTree!.leaves;
    const L = leaves.length;
    const pathSum = leaves.reduce((n, l) => n + l.proof.path.length, 0);
    expect(hasher4k.counts).toEqual({ leaf: 2 * L, node: L - 1 + pathSum });
  }, 300_000);
});

describe("artifact JSON size and serialization stability", () => {
  it("4,096 holders: pinned hash and byte size; a second run and a JSON round trip give the same bytes", async () => {
    const r = await cycle4k();
    const canonical = canonicalYieldArtifact(r.artifact);
    const bytes = new TextEncoder().encode(canonical).length;
    expect({ artifactSha256: r.artifactSha256, canonicalBytes: bytes, payable: r.artifact.claimTree!.size }).toEqual(PINNED_4K);
    // Independent rerun from the same seed and inputs.
    const again = await largeHolderCycle(4_096, SEED);
    expect(again.artifactSha256).toBe(r.artifactSha256);
    expect(canonicalYieldArtifact(again.artifact)).toBe(canonical);
    // Parsing and re-serializing the canonical form is the identity (bigints are decimal strings).
    expect(canonicalYieldArtifact(JSON.parse(canonical))).toBe(canonical);
    // Serializing does not touch the frozen artifact.
    expect(Object.isFrozen(r.artifact) && Object.isFrozen(r.artifact.claimTree!.leaves)).toBe(true);
    expect(await yieldArtifactHash(r.artifact)).toBe(r.artifactSha256);
  }, 300_000);

  it("16,384 holders: at most 2,560 bytes per holder, under 64 MiB, and at most 4.5× the 4,096-holder size", async () => {
    const [small, large] = [await cycle4k(), await cycle16k()];
    const bytes4 = new TextEncoder().encode(canonicalYieldArtifact(small.artifact)).length;
    const bytes16 = new TextEncoder().encode(canonicalYieldArtifact(large.artifact)).length;
    expect(bytes16 / 16_384).toBeLessThanOrEqual(2_560);
    expect(bytes16).toBeLessThan(64 * MiB);
    expect(bytes16 / bytes4).toBeLessThanOrEqual(4.5);
    expect(canonicalYieldArtifact(large.artifact)).toBe(canonicalYieldArtifact(large.artifact));
  }, 300_000);
});

describe("lookup verification throughput (16,384 holders, 512 seeded holders)", () => {
  it("re-verifies the artifact once, then verifies each claim with exactly 1 + path-length hashes", async () => {
    const r = await cycle16k();
    const L = r.artifact.claimTree!.size;
    const build = countingHasher();
    const lookup = await createClaimLookup(r.artifact, r.artifactSha256, build);
    // Opening the lookup re-verifies every proof once: L leaf hashes and Σ path node hashes.
    const pathSum = r.artifact.claimTree!.leaves.reduce((n, l) => n + l.proof.path.length, 0);
    expect(build.counts).toEqual({ leaf: L, node: pathSum });

    const picked = pickParties(
      r.ownership.entries.map((e) => e.partyId),
      512,
      0x7e57n,
    );
    const verify = countingHasher();
    const statuses: Record<string, number> = {};
    let expectedNodes = 0;
    let claims = 0;
    const t0 = now();
    for (const partyId of picked) {
      const res = lookup.byPartyId(partyId);
      const key = res.status === "no_leaf" ? `${res.reason}${res.reason === "deferred" ? `:${res.deferredReason}` : ""}` : res.status;
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (res.status !== "claim") continue;
      expect(res.claim.amount).not.toBe("0");
      expect(await verifyClaimPayload(res.claim, lookup.published!, verify)).toBe(true);
      expectedNodes += res.claim.path.length;
      claims++;
    }
    const elapsed = now() - t0;
    expect(verify.counts).toEqual({ leaf: claims, node: expectedNodes });
    expect(expectedNodes / claims).toBeLessThanOrEqual(ceilLog2(L));
    // The seeded selection covers payable holders and zero-amount deferrals (tiny holders).
    expect(statuses.claim).toBeGreaterThan(256);
    expect(statuses["deferred:zero_amount"]).toBeGreaterThan(32);
    expect(Object.values(statuses).reduce((a, b) => a + b, 0)).toBe(512);
    expect(elapsed).toBeLessThan(60_000); // cap, not a target (local: well under 1 s)
  }, 300_000);
});

describe("fail-closed at scale", () => {
  it("refuses a real cycle, a non-simulation artifact, a tampered leaf among thousands, and real networks", async () => {
    const r = await cycle4k();
    expect(await code(() => calculateSimulationCycle({ ...r.input, ownership: r.ownership, cycle: { ...r.input.cycle, simulation: false } }))).toBe("simulation_only");
    const real = structuredClone(r.artifact);
    real.cycle.simulation = false;
    expect(await code(() => createClaimLookup(real, r.artifactSha256, SHA256_RFC9162_HASHER))).toBe("simulation_only");
    const tampered = structuredClone(r.artifact);
    tampered.claimTree!.leaves[2_000]!.proof.path[3] = "f".repeat(64);
    const problems = await cycleArtifactProblems(tampered, await yieldArtifactHash(tampered), SHA256_RFC9162_HASHER);
    expect(problems.some((p) => p.includes("leaf 2000"))).toBe(true);
    for (const networkId of ["solana-mainnet", "mainnet-beta", "tron"])
      expect(await code(() => loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter({ seed: 1n, holders: 16_384, profile: "extreme", withheldEvery: 0, unattributed: 0, observedAt: "2026-09-30T23:59:59Z" }), { ...LARGE_REQUEST, networkId }))).toBe("real_network");
  }, 300_000);
});

describe("large-tree sample shared with C#", () => {
  it("the committed file is exactly what the live pipeline produces", async () => {
    expect(readFileSync(SAMPLE, "utf8")).toBe(await largeTreeSampleText());
  }, 300_000);

  it("every claim verifies; zero-amount holders have no claim", async () => {
    const s = JSON.parse(readFileSync(SAMPLE, "utf8")) as { publishedTree: PublishedClaimTree; claims: ClaimPayloadDto[]; lookups: { partyId: string; status: string; deferredReason?: string }[] };
    const claimed = new Set(s.claims.map((c) => c.partyId));
    for (const c of s.claims) expect(await verifyClaimPayload(c, s.publishedTree, SHA256_RFC9162_HASHER)).toBe(true);
    const zeros = s.lookups.filter((l) => l.deferredReason === "zero_amount");
    expect(zeros.length).toBeGreaterThan(0);
    expect(zeros.some((z) => claimed.has(z.partyId))).toBe(false);
  });
});
