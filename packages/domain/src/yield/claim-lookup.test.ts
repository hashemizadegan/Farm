import { describe, expect, it } from "vitest";
import { yieldArtifactHash } from "./artifact";
import { SHA256_RFC9162_HASHER } from "./claim-tree";
import { type ClaimLookupError, type ClaimPayloadDto, createClaimLookup, serializeClaimPayload, verifyClaimPayload } from "./claim-lookup";
import { calculateSimulationCycle } from "./pipeline";
import { input } from "./pipeline.scenario.test-support";

const live = async () => {
  const r = await calculateSimulationCycle(await input());
  return { ...r, lookup: await createClaimLookup(r.artifact, r.artifactSha256, SHA256_RFC9162_HASHER) };
};
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as ClaimLookupError).code ?? (e as Error).name;
  }
  return "no error";
};

describe("claim lookup over the pipeline's frozen artifact", () => {
  it("finds payable holders by party id and by payout address, with the exact client payload", async () => {
    const { lookup, artifact } = await live();
    const a = lookup.byPartyId("party-a");
    expect(a.status).toBe("claim");
    const claim = (a as { claim: ClaimPayloadDto }).claim;
    expect(claim).toEqual({
      scheme: "metafarm-yield-claim/1",
      cycleId: artifact.cycle.id,
      cycleVersion: 1,
      simulation: true,
      hasherId: "sha256-rfc9162-double-leaf/1",
      root: artifact.claimTree!.root,
      treeSize: 2,
      leafIndex: 0,
      partyId: "party-a",
      recipient: "01".repeat(32),
      amount: "2677500000",
      leafBytes: artifact.claimTree!.leaves[0]!.leafBytes,
      leafHash: artifact.claimTree!.leaves[0]!.leafHash,
      path: artifact.claimTree!.leaves[0]!.proof.path,
    });
    // Party B's payout address is the wSOL mint address (base58); hex works too.
    const byAddress = lookup.byPayoutAddress("So11111111111111111111111111111111111111112");
    expect(byAddress).toEqual(lookup.byPartyId("party-b"));
    expect(lookup.byPayoutAddress("01".repeat(32))).toEqual(a);
  });

  it("explains holders without a leaf instead of returning nothing", async () => {
    const { lookup } = await live();
    expect(lookup.byPartyId("party-c")).toEqual({ status: "no_leaf", reason: "withheld" });
    expect(lookup.byPartyId("party-d")).toEqual({ status: "no_leaf", reason: "deferred" });
    expect(lookup.byPayoutAddress("03".repeat(32))).toEqual({ status: "no_leaf", reason: "deferred" });
    expect(lookup.byPartyId("token-account-x")).toEqual({ status: "unattributed" });
    expect(lookup.byPartyId("nobody")).toEqual({ status: "not_in_cycle" });
    expect(lookup.byPayoutAddress("not-an-address")).toEqual({ status: "not_in_cycle" });
    expect(lookup.byPayoutAddress("ff".repeat(32))).toEqual({ status: "not_in_cycle" });
  });

  it("serves payloads that verify against the published tree, and serializes them canonically", async () => {
    const { lookup } = await live();
    for (const c of lookup.all()) {
      expect(await verifyClaimPayload(c, lookup.published!, SHA256_RFC9162_HASHER)).toBe(true);
      expect(JSON.parse(serializeClaimPayload(c))).toEqual(c);
      expect(Object.keys(JSON.parse(serializeClaimPayload(c)))).toEqual([...Object.keys(c)].sort());
    }
  });

  it("rejects payloads that disagree with their leaf or the trusted tree", async () => {
    const { lookup } = await live();
    const c = lookup.all()[1]!;
    const p = lookup.published!;
    const bad: Partial<ClaimPayloadDto>[] = [{ amount: "1" }, { recipient: "02".repeat(32) }, { leafIndex: 0 }, { treeSize: 3 }, { root: "0".repeat(64) }, { cycleVersion: 2 }, { hasherId: "other" }, { path: [] }, { leafBytes: c.leafBytes.slice(2) }, { simulation: false as never }];
    for (const patch of bad) expect(await verifyClaimPayload({ ...c, ...patch }, p, SHA256_RFC9162_HASHER), JSON.stringify(Object.keys(patch))).toBe(false);
    expect(await verifyClaimPayload(c, { ...p, root: "0".repeat(64) }, SHA256_RFC9162_HASHER)).toBe(false);
    expect(await verifyClaimPayload(c, { ...p, treeSize: 3 }, SHA256_RFC9162_HASHER)).toBe(false);
    // A real leaf of this cycle presented as another cycle's (same root, other cycle id or version) is refused.
    expect(await verifyClaimPayload({ ...c, cycleId: "00000000-0000-4000-8000-0000000000c2" }, { ...p, cycleId: "00000000-0000-4000-8000-0000000000c2" }, SHA256_RFC9162_HASHER)).toBe(false);
    expect(await verifyClaimPayload({ ...c, cycleVersion: 2 }, { ...p, cycleVersion: 2 }, SHA256_RFC9162_HASHER)).toBe(false);
  });

  it("is read-only: payloads and the lookup are frozen", async () => {
    const { lookup } = await live();
    const c = lookup.all()[0]!;
    expect(Object.isFrozen(lookup) && Object.isFrozen(c) && Object.isFrozen(c.path) && Object.isFrozen(lookup.published)).toBe(true);
    expect(() => {
      (c as { amount: string }).amount = "1";
    }).toThrow(TypeError);
  });

  it("fails closed: refuses non-simulation and unverifiable artifacts", async () => {
    const { artifact, artifactSha256 } = await live();
    const real = structuredClone(artifact);
    real.cycle.simulation = false;
    expect(await code(() => createClaimLookup(real, artifactSha256, SHA256_RFC9162_HASHER))).toBe("simulation_only");
    const tampered = structuredClone(artifact);
    tampered.claimTree!.leaves[0]!.proof.path[0] = "f".repeat(64);
    expect(await code(async () => createClaimLookup(tampered, await yieldArtifactHash(tampered), SHA256_RFC9162_HASHER))).toBe("artifact_invalid");
    expect(await code(() => createClaimLookup(artifact, "0".repeat(64), SHA256_RFC9162_HASHER))).toBe("artifact_invalid");
  });
});
