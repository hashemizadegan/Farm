import { describe, expect, it } from "vitest";
import { U64_MAX } from "./amounts";
import { type OwnershipSnapshotError, type OwnershipSnapshotInput, canonicalOwnershipSnapshot, ownershipSnapshotProblems, verifyAndNormalizeSnapshot } from "./ownership-snapshot";
import { SNAPSHOT_INPUT, VERIFIED_AT, scenarioSnapshot } from "./pipeline.scenario.test-support";

const WSOL = "So11111111111111111111111111111111111111112";
const WSOL_HEX = "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
const verify = (patch: Partial<OwnershipSnapshotInput>) => verifyAndNormalizeSnapshot({ ...SNAPSHOT_INPUT, ...patch }, { verifiedAt: VERIFIED_AT });
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as OwnershipSnapshotError).code ?? (e as Error).name;
  }
  return "no error";
};
const entry = (partyId: string, rawShares: bigint, payoutAddress: string | null = null) => ({ partyId, payoutAddress, rawShares });

describe("verifyAndNormalizeSnapshot", () => {
  it("normalises the scenario snapshot and commits to it (independent Python vector)", async () => {
    const s = await scenarioSnapshot();
    // Python: json.dumps(committed content, sort_keys=True, separators=(",", ":")) → hashlib.sha256.
    expect(s.snapshotHash).toBe("bb57ff8d4fcf9adbfae0d505004022e73cbd1535848641fde2c493bf884d5ddd");
    expect(s.totalRawShares).toBe(100n);
    expect(s.assetId).toBe("bb".repeat(32));
    expect(s.entries.map((e) => [e.partyId, e.recipient, e.rawShares])).toEqual([
      ["party-a", "01".repeat(32), 50n],
      ["party-b", WSOL_HEX, 30n],
      ["party-c", null, 15n],
      ["party-d", "03".repeat(32), 1n],
    ]);
    expect(s.entries.every((e) => e.shareBasis.denominator === 100n && e.shareBasis.numerator === e.rawShares)).toBe(true);
    expect(s.diagnostics).toEqual({ partyCount: 4, withheldCount: 1, unattributedCount: 1, unattributedRawShares: 4n, minRawShares: 1n, maxRawShares: 50n });
    expect(s.verifiedAt).toBe(VERIFIED_AT);
  });

  it("is deeply frozen", async () => {
    const s = await scenarioSnapshot();
    expect(Object.isFrozen(s) && Object.isFrozen(s.entries) && Object.isFrozen(s.entries[0]) && Object.isFrozen(s.entries[0]!.shareBasis) && Object.isFrozen(s.diagnostics)).toBe(true);
    expect(() => {
      (s.entries[0] as { rawShares: bigint }).rawShares = 51n;
    }).toThrow(TypeError);
  });

  it("commits to the normalised address, not its spelling, nor to the verification time", async () => {
    const base = await scenarioSnapshot();
    const hexSpelling = await verify({ entries: SNAPSHOT_INPUT.entries.map((e) => (e.partyId === "party-b" ? { ...e, payoutAddress: WSOL_HEX } : e)) });
    expect(hexSpelling.snapshotHash).toBe(base.snapshotHash);
    expect((await verifyAndNormalizeSnapshot(SNAPSHOT_INPUT, { verifiedAt: "2026-10-02T00:00:00Z" })).snapshotHash).toBe(base.snapshotHash);
    expect(canonicalOwnershipSnapshot(hexSpelling)).toBe(canonicalOwnershipSnapshot(base));
  });

  it("changes the commitment when a single raw share unit, an address or the reference changes", async () => {
    const base = (await scenarioSnapshot()).snapshotHash;
    const variants: Partial<OwnershipSnapshotInput>[] = [
      { entries: SNAPSHOT_INPUT.entries.map((e) => (e.partyId === "party-a" ? { ...e, rawShares: 51n } : e)) },
      { entries: SNAPSHOT_INPUT.entries.map((e) => (e.partyId === "party-a" ? { ...e, payoutAddress: "04".repeat(32) } : e)) },
      { unattributed: [{ holderKey: "token-account-x", rawShares: 5n }] },
      { reference: { ...SNAPSHOT_INPUT.reference, value: 123_456_790n } },
      { snapshotId: "00000000-0000-4000-8000-0000000000e2" },
      { assetId: "bc".repeat(32) },
      { networkId: "solana-localnet" },
    ];
    const hashes = new Set([base]);
    for (const v of variants) hashes.add((await verify(v)).snapshotHash);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("sums totals exactly beyond u64 (each holding is u64; the total need not be)", async () => {
    const s = await verify({ entries: [entry("a", U64_MAX), entry("b", U64_MAX)], unattributed: [] });
    expect(s.totalRawShares).toBe(2n * U64_MAX);
  });

  it("refuses zero, negative, overflowing and non-bigint shares", async () => {
    for (const rawShares of [0n, -1n, U64_MAX + 1n, 50 as never, 1.5 as never, "50" as never])
      expect(await code(() => verify({ entries: [entry("a", rawShares)], unattributed: [] })), String(rawShares)).toBe("invalid_shares");
    expect(await code(() => verify({ entries: [entry("a", 1n)], unattributed: [{ holderKey: "h", rawShares: 0n }] }))).toBe("invalid_shares");
  });

  it("refuses duplicates: parties, payout addresses in any spelling, and holder keys", async () => {
    expect(await code(() => verify({ entries: [entry("a", 1n), entry("a", 2n)], unattributed: [] }))).toBe("duplicate_party");
    expect(await code(() => verify({ entries: [entry("a", 1n, WSOL), entry("b", 2n, WSOL_HEX)], unattributed: [] }))).toBe("duplicate_payout_address");
    expect(await code(() => verify({ unattributed: [{ holderKey: "h", rawShares: 1n }, { holderKey: "h", rawShares: 2n }] }))).toBe("duplicate_holder");
    expect(await code(() => verify({ unattributed: [{ holderKey: "party-a", rawShares: 1n }] }))).toBe("duplicate_holder");
  });

  it("refuses input that is not already in canonical order, rather than re-sorting it", async () => {
    expect(await code(() => verify({ entries: [...SNAPSHOT_INPUT.entries].reverse() }))).toBe("not_canonical_order");
    expect(await code(() => verify({ unattributed: [{ holderKey: "b", rawShares: 1n }, { holderKey: "a", rawShares: 1n }] }))).toBe("not_canonical_order");
  });

  it("refuses an empty snapshot (zero total)", async () => {
    expect(await code(() => verify({ entries: [], unattributed: [] }))).toBe("zero_total");
  });

  it("refuses real networks: simulation identifiers only", async () => {
    for (const networkId of ["solana-mainnet", "mainnet-beta", "solana-devnet", "tron", "tron-mainnet", "Simulation", ""]) expect(await code(() => verify({ networkId })), networkId).toBe("real_network");
  });

  it("refuses malformed fields and unsupported keys", async () => {
    const bad: Partial<OwnershipSnapshotInput>[] = [
      { snapshotId: "not-a-uuid" },
      { snapshotId: "00000000-0000-4000-8000-0000000000E1" },
      { assetId: "bb".repeat(31) },
      { reference: { ...SNAPSHOT_INPUT.reference, value: -1n } },
      { reference: { ...SNAPSHOT_INPUT.reference, observedAt: "2026-02-30T00:00:00Z" } },
      { reference: { ...SNAPSHOT_INPUT.reference, kind: "epoch" as never } },
      { entries: [{ partyId: " a", payoutAddress: null, rawShares: 1n }] },
      { entries: [{ partyId: "a", payoutAddress: "not-an-address", rawShares: 1n }] },
      { entries: [{ partyId: "a", rawShares: 1n } as never] },
      { entries: [{ partyId: "a", payoutAddress: null, rawShares: 1n, weight: 1 } as never] },
      { entries: [{ partyId: "a", payoutAddress: null, rawShares: 1n, metadata: { n: 1 } as never }] },
    ];
    for (const patch of bad) expect(await code(() => verify(patch)), JSON.stringify(patch, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe("invalid_snapshot");
    expect(await code(() => verifyAndNormalizeSnapshot({ ...SNAPSHOT_INPUT, chain: "x" } as never, { verifiedAt: VERIFIED_AT }))).toBe("invalid_snapshot");
    expect(await code(() => verifyAndNormalizeSnapshot(SNAPSHOT_INPUT, { verifiedAt: "yesterday" }))).toBe("invalid_snapshot");
  });
});

describe("ownershipSnapshotProblems (re-checking an embedded snapshot)", () => {
  it("accepts an intact snapshot", async () => {
    expect(await ownershipSnapshotProblems(await scenarioSnapshot())).toEqual([]);
  });

  it("detects a single raw share unit changed, even with the total and bases adjusted to match", async () => {
    const t = structuredClone(await scenarioSnapshot());
    t.entries[0]!.rawShares += 1n;
    t.entries[0]!.shareBasis.numerator += 1n;
    t.totalRawShares += 1n;
    for (const e of t.entries) e.shareBasis.denominator = t.totalRawShares;
    for (const u of t.unattributed) u.shareBasis.denominator = t.totalRawShares;
    expect(await ownershipSnapshotProblems(t)).toEqual(["the snapshot does not hash to its recorded snapshot hash"]);
  });

  it("detects a changed address, a broken total, a real network and a recipient that no longer matches its address", async () => {
    const s = await scenarioSnapshot();
    const address = structuredClone(s);
    address.entries[0]!.recipient = "04".repeat(32);
    expect(await ownershipSnapshotProblems(address)).toContain("the snapshot does not hash to its recorded snapshot hash");
    expect(await ownershipSnapshotProblems(address)).toContain("the recipient of party-a does not match its payout address");
    const total = structuredClone(s);
    total.totalRawShares = 99n;
    expect(await ownershipSnapshotProblems(total)).toContain("totalRawShares is not the sum of the raw shares");
    const real = structuredClone(s) as unknown as { networkId: string };
    real.networkId = "solana-mainnet";
    expect(await ownershipSnapshotProblems(real as never)).toContain("network solana-mainnet is not a simulation network");
  });
});
