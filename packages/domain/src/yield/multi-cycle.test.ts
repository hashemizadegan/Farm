/**
 * Multi-cycle simulation (3 cycles × 4,096 holders) with carry-forward and a correction of cycle 2. Harness rules
 * are in multi-cycle.test-support.ts: carry-forward is exactly the predecessor's ledgerOut; corrections are new
 * versions of the same cycle id (latest wins); later cycles are rebased onto the corrected history; stale cycles
 * are never served.
 *
 * Conservation terms used here (all settlement base units, per cycle version):
 *   inflow    = settlement amount + carried remainder in + Σ deferred dust in
 *   outflow   = claims (leaf total) + deferred dust out + withheld + unattributed + carried remainder out
 * and inflow = outflow exactly. Across the chain (latest versions), new money is only the settlement amounts:
 *   Σ settlement = Σ (claims + withheld + unattributed) + final carry (remainder + Σ deferred of the last ledgerOut)
 * which fails if any carried unit were counted twice or dropped.
 */
import { describe, expect, it } from "vitest";
import { SHA256_RFC9162_HASHER } from "./claim-tree";
import { createClaimLookup } from "./claim-lookup";
import { decodeReadModelImage, encodeReadModelImage, projectClaimReadModel } from "./claim-read-model";
import { pickParties } from "./large-holder.test-support";
import { CHAIN_DEFAULTS, CYCLE2_CORRECTED_LINES, ChainServingError, type PublishedVersion, PublishedVersionsIndex, SimulationChain } from "./multi-cycle.test-support";
import { cycleArtifactProblems } from "./pipeline";

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const carryOf = (l: PublishedVersion["ledgerOut"]) => l.carriedRemainder + sum(l.deferred.map((d) => d.amount));

/** Per-cycle conservation and "carry applied exactly once" for one published version. */
function checkVersion(v: PublishedVersion) {
  const a = v.artifact;
  const t = a.totals;
  const plan = a.distribution.plan;
  // The ledger that came in is exactly the one recorded in the plan, and is counted once in the inflow.
  expect(plan.ledgerIn).toEqual({ carriedRemainder: v.ledgerIn.carriedRemainder, deferred: [...v.ledgerIn.deferred] });
  expect(t.inflow).toBe(a.calculation.settlementAmount + carryOf(v.ledgerIn));
  // inflow == claims + deferred dust + withheld + unattributed + carried remainder.
  expect(t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried).toBe(t.inflow);
  expect(t.remainderCarried).toBe(plan.ledgerOut.carriedRemainder);
  expect(t.dustCarriedForward).toBe(sum(plan.ledgerOut.deferred.map((d) => d.amount)));
  // Each deferred amount carried in is applied exactly once: either added to its party's entry this cycle
  // (deferredIn), or, for a party with no share this cycle, carried out unchanged.
  const entries = new Map(plan.entries.filter((e) => e.kind === "party").map((e) => [e.partyId!, e]));
  for (const d of v.ledgerIn.deferred) {
    const e = entries.get(d.partyId);
    if (e) expect(e.deferredIn, d.partyId).toBe(d.amount);
    else expect(plan.ledgerOut.deferred.find((x) => x.partyId === d.partyId)?.amount, d.partyId).toBe(d.amount);
  }
  // No deferredIn appears from nowhere.
  const carriedIn = new Map(v.ledgerIn.deferred.map((d) => [d.partyId, d.amount]));
  for (const e of entries.values()) expect(e.deferredIn).toBe(carriedIn.get(e.partyId!) ?? 0n);
}

/** Chain-level conservation over a sequence of versions that carry into each other. */
function checkChain(chain: PublishedVersion[]) {
  for (let i = 1; i < chain.length; i++) {
    expect(chain[i]!.basedOn).toEqual({ cycleId: chain[i - 1]!.cycleId, version: chain[i - 1]!.version });
    expect(chain[i]!.ledgerIn).toBe(chain[i - 1]!.ledgerOut); // the very same ledger object: carried once, unmodified
  }
  const settled = sum(chain.map((v) => v.artifact.calculation.settlementAmount));
  const leftChain = sum(chain.map((v) => v.artifact.totals.leaves + v.artifact.totals.withheld + v.artifact.totals.unattributed));
  expect(settled).toBe(leftChain + carryOf(chain[chain.length - 1]!.ledgerOut));
}

// One chain for the file (deterministic): 3 cycles published, then cycle 2 corrected and cycle 3 rebased.
let built: Promise<{ chain: SimulationChain; before: PublishedVersion[]; after: PublishedVersion[] }> | undefined;
const scenario = () =>
  (built ??= (async () => {
    const chain = new SimulationChain(CHAIN_DEFAULTS);
    const before = await chain.publishAll();
    const after = await chain.correct(1, { evidenceLines: CYCLE2_CORRECTED_LINES });
    return { chain, before, after };
  })());

// Pinned for the fixed seeds and inputs (new pins; nothing existing changes).
const PINNED = {
  artifacts: [
    ["c0001", 1, "77f3a1db722a7b7f606903c16c1b33cf6dea5362e192faccf6805cf019ea4b24"],
    ["c0002", 1, "36e1d5c1f791fa48844389bc6a3cf899cc528bd818b70b210fe874673e527ac6"],
    ["c0003", 1, "e3a4fb122bd9b0ce210d9a2c6896b02eb6b8ae18e44663b26d78ad9a7ed649ac"],
    ["c0002", 2, "aa5ec40817b7cb30b2993a30d755e382a110ad5d47017fe60c800b455cb2b189"],
    ["c0003", 2, "3d2bc4d779888cc59bf2dbe31d5151063fbb60ca7727803d07fd395de076cf28"],
  ],
  image: { sha256: "12b0dae6ba8e10fbd4780bfa076e50e58dc9813fe1e0b137358eb7e335e40d4d", bytes: 18_997_154 },
};

describe("multi-cycle chain (3 × 4,096 holders, carry remainder, dust 1,000,000)", () => {
  it("carries remainder and dust between cycles, each cycle conserving exactly and applying the carry once", async () => {
    const { before } = await scenario();
    expect(before.map((v) => [v.cycleId.slice(-5), v.version])).toEqual([
      ["c0001", 1],
      ["c0002", 1],
      ["c0003", 1],
    ]);
    expect(before[0]!.ledgerIn).toEqual({ carriedRemainder: 0n, deferred: [] });
    // Carry actually flows: a remainder and deferred dust leave cycle 1 and enter cycle 2.
    expect(before[0]!.ledgerOut.carriedRemainder).toBeGreaterThan(0n);
    expect(before[0]!.ledgerOut.deferred.length).toBeGreaterThan(0);
    // Some dust deferred in cycle 1 is paid in cycle 2 (deferredIn on a payable entry).
    expect(before[1]!.artifact.distribution.plan.entries.some((e) => e.state === "payable" && e.deferredIn > 0n)).toBe(true);
    for (const v of before) checkVersion(v);
    checkChain(before);
    for (const v of before) expect(await cycleArtifactProblems(v.artifact, v.artifactSha256, SHA256_RFC9162_HASHER)).toEqual([]);
  }, 600_000);

  it("is deterministic: pinned artifact hashes for every published version and a pinned read-model image", async () => {
    const { chain } = await scenario();
    const published = chain.cycleIds.flatMap((id) => chain.history(id)).sort((a, b) => a.version - b.version || a.cycleId.localeCompare(b.cycleId));
    expect(published.map((v) => [v.cycleId.slice(-5), v.version, v.artifactSha256])).toEqual(PINNED.artifacts);
    const image = await encodeReadModelImage(chain.store);
    expect({ sha256: image.sha256, bytes: image.bytes.length }).toEqual(PINNED.image);
    // The multi-cycle, multi-version store round-trips.
    const reloaded = await decodeReadModelImage(image.bytes, image.sha256);
    expect((await encodeReadModelImage(reloaded)).sha256).toBe(image.sha256);
  }, 600_000);
});

describe("correction of cycle 2 (latest wins) and rebase of cycle 3", () => {
  it("publishes cycle 2 v2 under the same cycle id with a different artifact hash and a different carry-out", async () => {
    const { chain } = await scenario();
    const [v1, v2] = chain.history(CHAIN_DEFAULTS.cycles[1]!.cycleId);
    expect([v1!.version, v2!.version]).toEqual([1, 2]);
    expect(v2!.artifact.cycle.id).toBe(v1!.artifact.cycle.id);
    expect(v2!.artifactSha256).not.toBe(v1!.artifactSha256);
    // The correction raises revenue by 500.00, so cycle 2 settles more and carries out a different ledger.
    expect(v2!.artifact.calculation.settlementAmount).toBeGreaterThan(v1!.artifact.calculation.settlementAmount);
    expect(v2!.ledgerOut).not.toEqual(v1!.ledgerOut);
    // Both versions of cycle 2 were based on the same (unchanged) cycle 1.
    expect(v2!.basedOn).toEqual(v1!.basedOn);
    expect(v2!.ledgerIn).toBe(v1!.ledgerIn);
    checkVersion(v2!);
  }, 600_000);

  it("rebases cycle 3 onto the corrected history; the latest chain conserves and has no stale cycle", async () => {
    const { chain, after } = await scenario();
    expect(after.map((v) => [v.cycleId.slice(-5), v.version])).toEqual([
      ["c0001", 1],
      ["c0002", 2],
      ["c0003", 2],
    ]);
    const [c3v1, c3v2] = chain.history(CHAIN_DEFAULTS.cycles[2]!.cycleId);
    expect(c3v2!.basedOn).toEqual({ cycleId: CHAIN_DEFAULTS.cycles[1]!.cycleId, version: 2 });
    expect(c3v2!.ledgerIn).toBe(after[1]!.ledgerOut);
    expect(c3v2!.artifactSha256).not.toBe(c3v1!.artifactSha256);
    // Same snapshot and evidence as v1: only the carried-in ledger differs.
    expect(c3v2!.ownership).toBe(c3v1!.ownership);
    expect(c3v2!.evidenceLines).toBe(c3v1!.evidenceLines);
    checkVersion(c3v2!);
    checkChain(after);
    expect(chain.chainProblems()).toEqual([]);
    // The superseded chain (1v1, 2v1, 3v1) still conserves on its own: corrections never rewrite history.
    checkChain(chain.cycleIds.map((id) => chain.history(id)[0]!));
  }, 600_000);

  it("the read model serves the latest version of each cycle; superseded versions stay readable by version", async () => {
    const { chain, after } = await scenario();
    for (const v of after) {
      const model = await chain.open(v.cycleId);
      expect([model.header.cycleVersion, model.header.artifactSha256]).toEqual([v.version, v.artifactSha256]);
      // Seeded holders: the served results equal the in-memory lookup of the latest artifact.
      const lookup = await createClaimLookup(v.artifact, v.artifactSha256, SHA256_RFC9162_HASHER);
      const picked = pickParties(
        v.ownership.entries.map((e) => e.partyId),
        256,
        0xc0de0n + BigInt(v.version),
      );
      for (const p of picked) expect(await model.byPartyId(p)).toEqual(lookup.byPartyId(p));
    }
    // Cycle 2 v1 is still in the store for audit, opened explicitly by version, with its own artifact hash.
    const c2 = CHAIN_DEFAULTS.cycles[1]!.cycleId;
    const old = await chain.open(c2, 1);
    expect([old.header.cycleVersion, old.header.artifactSha256]).toEqual([1, chain.history(c2)[0]!.artifactSha256]);
    expect((await chain.open(c2)).header.cycleVersion).toBe(2);
  }, 600_000);

  it("fails closed on a stale downstream cycle (correction without rebase) and on republishing a version", async () => {
    const chain = new SimulationChain({ ...CHAIN_DEFAULTS, holders: 256 });
    await chain.publishAll();
    await chain.correct(1, { evidenceLines: CYCLE2_CORRECTED_LINES }, { rebase: false });
    const c3 = CHAIN_DEFAULTS.cycles[2]!.cycleId;
    expect(chain.chainProblems()).toEqual([`cycle ${c3} v1 is stale: based on ${CHAIN_DEFAULTS.cycles[1]!.cycleId} v1, latest is v2`]);
    await expect(chain.open(c3)).rejects.toThrow(/refusing to serve/);
    // The stale version is still readable explicitly (audit), but never as "latest".
    expect((await chain.open(c3, 1)).header.cycleVersion).toBe(1);
    // The store is immutable: the same cycle version cannot be projected twice.
    const v = chain.latest(c3);
    await expect(projectClaimReadModel(v.artifact, v.artifactSha256, SHA256_RFC9162_HASHER, chain.store)).rejects.toThrow(/already exists/);
    // Non-simulation policy records are refused by the harness before anything runs.
    expect(() => new SimulationChain({ ...CHAIN_DEFAULTS, distributionPolicy: { ...CHAIN_DEFAULTS.distributionPolicy, status: "approved" } })).toThrow(/simulation/);
  }, 600_000);
});

const errorOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return e instanceof ChainServingError ? { code: e.code, message: e.message } : { code: "other", message: String(e) };
  }
  return { code: "no error", message: "" };
};

describe("staleness: serving vs audit reads", () => {
  it("before cycle 3 is rebuilt, serving its latest version fails closed with a stable error; v1 stays readable for audit", async () => {
    const chain = new SimulationChain({ ...CHAIN_DEFAULTS, holders: 256 });
    await chain.publishAll();
    await chain.correct(1, { evidenceLines: CYCLE2_CORRECTED_LINES }, { rebase: false });
    const [c1, c2, c3] = CHAIN_DEFAULTS.cycles.map((c) => c.cycleId) as [string, string, string];
    // Serving "latest" of cycle 3: refused with code stale_cycle and an exact message.
    expect(await errorOf(() => chain.open(c3))).toEqual({ code: "stale_cycle", message: `refusing to serve cycle ${c3} v1 is stale: based on ${c2} v1, latest is v2` });
    // Its predecessors are not stale and are served (cycle 2 at its corrected version).
    expect((await chain.open(c1)).header.cycleVersion).toBe(1);
    expect((await chain.open(c2)).header.cycleVersion).toBe(2);
    // Audit read: cycle 3 v1 opened by explicit version still works, pinned to its own artifact, and serves claims.
    const audit = await chain.open(c3, 1);
    const v1 = chain.history(c3)[0]!;
    expect([audit.header.cycleVersion, audit.header.artifactSha256]).toEqual([1, v1.artifactSha256]);
    const leaf = v1.artifact.claimTree!.leaves[0]!;
    const served = await audit.byPartyId(leaf.partyId);
    expect(served.status === "claim" && served.claim.amount).toBe(leaf.amount.toString());
    // Versions that were never published, and unknown cycles, are refused explicitly.
    expect(await errorOf(() => chain.open(c3, 2))).toEqual({ code: "unknown_version", message: `cycle ${c3} has no version 2` });
    expect(await errorOf(() => chain.open("00000000-0000-4000-8000-0000000c0009"))).toEqual({ code: "unknown_cycle", message: "cycle 00000000-0000-4000-8000-0000000c0009 has not been published" });
  }, 600_000);
});

describe("published-versions index", () => {
  const entry = (cycleId: string, version: number, fill = String(version % 10)) => ({ cycleId, version, artifactSha256: fill.repeat(64) });

  it("latest is monotonic per cycle id: it only ever moves to latest + 1", () => {
    const idx = new PublishedVersionsIndex<ReturnType<typeof entry>>();
    const seen: number[] = [];
    for (const v of [1, 2, 3, 4]) {
      idx.record(entry("a", v));
      seen.push(idx.latest("a").version);
      if (v <= 2) idx.record(entry("b", v)); // independent per cycle id
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(idx.latest("b").version).toBe(2);
    expect(idx.versions("a").map((e) => e.version)).toEqual([1, 2, 3, 4]);
    expect(idx.version("a", 2).artifactSha256).toBe("2".repeat(64)); // earlier versions stay addressable
  });

  it("refuses gaps and out-of-order versions deterministically, leaving the index unchanged", () => {
    const idx = new PublishedVersionsIndex<ReturnType<typeof entry>>();
    expect(() => idx.record(entry("a", 2))).toThrow(new ChainServingError("version_gap", "cycle a: v2 would skip v1"));
    idx.record(entry("a", 1));
    idx.record(entry("a", 2));
    const refusals = [
      [entry("a", 4), "version_gap", "cycle a: v4 would skip v3"], // v4 published without v3
      [entry("a", 2, "f"), "version_not_monotonic", "cycle a: v2 is not after the latest published v2"], // a repeat, even with another hash
      [entry("a", 1), "version_not_monotonic", "cycle a: v1 is not after the latest published v2"], // older
      [entry("a", 0), "invalid_version", "cycle a: version must be an integer >= 1, got 0"],
      [entry("a", 3.5), "invalid_version", "cycle a: version must be an integer >= 1, got 3.5"],
      [{ cycleId: "a", version: 3, artifactSha256: "XYZ" }, "invalid_version", "cycle a v3: artifactSha256 must be 64 lowercase hex"],
    ] as const;
    for (const [e, code, message] of refusals) {
      let caught: unknown;
      try {
        idx.record(e);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ChainServingError);
      expect([(caught as ChainServingError).code, (caught as ChainServingError).message]).toEqual([code, message]);
      expect(idx.latest("a")).toEqual(entry("a", 2)); // unchanged after every refusal
    }
    expect(() => idx.latest("nope")).toThrow(new ChainServingError("unknown_cycle", "cycle nope has not been published"));
    expect(() => idx.version("a", 3)).toThrow(new ChainServingError("unknown_version", "cycle a has no version 3"));
  });

  it("the chain's own index holds contiguous versions, and refuses a forged republish or a gapped version", async () => {
    const { chain } = await scenario();
    for (const id of chain.cycleIds) {
      const versions = chain.history(id).map((v) => v.version);
      expect(versions).toEqual(versions.map((_, i) => i + 1));
      expect(chain.latest(id).version).toBe(versions.length);
    }
    const c2 = CHAIN_DEFAULTS.cycles[1]!.cycleId;
    const latest = chain.latest(c2);
    expect(await errorOf(() => chain.index.record({ ...latest }))).toEqual({ code: "version_not_monotonic", message: `cycle ${c2}: v2 is not after the latest published v2` });
    expect(await errorOf(() => chain.index.record({ ...latest, version: 4 }))).toEqual({ code: "version_gap", message: `cycle ${c2}: v4 would skip v3` });
    expect(chain.latest(c2)).toBe(latest);
  }, 600_000);
});
