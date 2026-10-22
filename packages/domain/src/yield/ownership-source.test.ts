import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentHash } from "../twin/commitments";
import { U64_MAX } from "./amounts";
import {
  FileFixtureOwnershipAdapter,
  type IOwnershipSourceAdapter,
  MockOwnershipAdapter,
  type MockOwnershipAdapterConfig,
  type OwnershipSnapshotRequest,
  type OwnershipSourceError,
  loadVerifiedOwnershipSnapshot,
  parseOwnershipFixture,
  serializeOwnershipFixture,
} from "./ownership-source";
import { type OwnershipSnapshotError, verifyAndNormalizeSnapshot } from "./ownership-snapshot";
import { SYNTHETIC_SHARE_PROFILES, generateSyntheticOwnership } from "./ownership-synthetic";
import { SNAPSHOT_INPUT, VERIFIED_AT } from "./pipeline.scenario.test-support";

const REQUEST: OwnershipSnapshotRequest = { assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot", value: 250_000_000n }, verifiedAt: VERIFIED_AT };
const MOCK: MockOwnershipAdapterConfig = { seed: 0x5eedn, holders: 40, profile: "extreme", withheldEvery: 7, unattributed: 3, observedAt: "2026-09-30T23:59:59Z" };
const REAL_NETWORKS = ["solana-mainnet", "mainnet-beta", "mainnet", "solana-devnet", "devnet", "testnet", "tron", "tron-mainnet", "ethereum", "Simulation", ""];

/** The committed fixture: `serializeOwnershipFixture(new MockOwnershipAdapter(MOCK).inputFor(REQUEST))`. */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/ownership-snapshot.fixture.json");
const fixtureText = () => serializeOwnershipFixture(new MockOwnershipAdapter(MOCK).inputFor(REQUEST));

const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as OwnershipSourceError | OwnershipSnapshotError).code ?? (e as Error).name;
  }
  return "no error";
};
const fileAdapter = (text: string | Uint8Array, expectedSha256: string | null = null) => new FileFixtureOwnershipAdapter({ read: async () => text, expectedSha256 });
const fixtureDoc = () => JSON.parse(serializeOwnershipFixture(SNAPSHOT_INPUT));
const scenarioRequest: OwnershipSnapshotRequest = { assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot", value: 123_456_789n }, verifiedAt: VERIFIED_AT };

describe("synthetic generator", () => {
  it("is deterministic, canonical and verifiable for every profile", async () => {
    for (const profile of SYNTHETIC_SHARE_PROFILES) {
      const params = { seed: 99n, holders: 300, profile, withheldEvery: 9, unattributed: 4, assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot" as const, value: 1n, observedAt: "2026-09-30T23:59:59Z" } };
      const a = generateSyntheticOwnership(params);
      expect(generateSyntheticOwnership(params)).toEqual(a);
      expect(a.snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // Already in canonical order: the verifier would refuse anything else.
      const ids = a.entries.map((e) => e.partyId);
      expect(ids).toEqual([...ids].sort());
      expect(a.entries.every((e) => e.rawShares > 0n && e.rawShares <= U64_MAX)).toBe(true);
      expect(a.entries.filter((e) => e.payoutAddress === null).length).toBe(33);
      expect(new Set(a.entries.map((e) => e.payoutAddress).filter(Boolean)).size).toBe(267);
      const s = await verifyAndNormalizeSnapshot(a, { verifiedAt: VERIFIED_AT });
      expect([s.diagnostics.partyCount, s.diagnostics.unattributedCount]).toEqual([300, 4]);
      expect(generateSyntheticOwnership({ ...params, seed: 100n }).entries).not.toEqual(a.entries);
    }
  });

  it("refuses real networks and malformed parameters before generating anything", async () => {
    const params = { seed: 1n, holders: 1, profile: "uniform" as const, withheldEvery: 0, unattributed: 0, assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot" as const, value: 1n, observedAt: "2026-09-30T23:59:59Z" } };
    for (const networkId of REAL_NETWORKS) expect(await code(() => generateSyntheticOwnership({ ...params, networkId })), networkId).toBe("real_network");
    for (const patch of [{ seed: -1n }, { seed: U64_MAX + 1n }, { holders: -1 }, { holders: 1_000_000 }, { holders: 1.5 }, { withheldEvery: -1 }, { unattributed: -1 }, { profile: "gaussian" as never }, { extra: 1 } as never])
      expect(await code(() => generateSyntheticOwnership({ ...params, ...patch })), JSON.stringify(Object.keys(patch))).toBe("invalid_snapshot");
  });
});

describe("MockOwnershipAdapter", () => {
  it("serves the same verified snapshot for the same config and request", async () => {
    const a = await loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter(MOCK), REQUEST);
    const b = await loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter({ ...MOCK }), REQUEST);
    expect(b).toEqual(a);
    expect(a.diagnostics).toMatchObject({ partyCount: 40, withheldCount: 5, unattributedCount: 3 });
    expect(a.reference).toEqual({ kind: "slot", value: 250_000_000n, observedAt: MOCK.observedAt });
    expect(Object.isFrozen(a)).toBe(true);
    const other = await loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter({ ...MOCK, seed: 0x5eefn }), REQUEST);
    expect(other.snapshotHash).not.toBe(a.snapshotHash);
  });

  it("is simulation only and frozen", () => {
    const m = new MockOwnershipAdapter(MOCK);
    expect(m.simulationOnly).toBe(true);
    expect(Object.isFrozen(m)).toBe(true);
  });
});

describe("loadVerifiedOwnershipSnapshot fails closed", () => {
  it("refuses a real network request without calling the adapter", async () => {
    let calls = 0;
    const spy: IOwnershipSourceAdapter = { adapterId: "spy", simulationOnly: true, loadSnapshot: async (r) => {
        calls++;
        return new MockOwnershipAdapter(MOCK).loadSnapshot(r);
      },
    };
    for (const networkId of REAL_NETWORKS) expect(await code(() => loadVerifiedOwnershipSnapshot(spy, { ...REQUEST, networkId })), networkId).toBe("real_network");
    expect(calls).toBe(0);
  });

  it("refuses malformed requests and adapters that do not declare themselves simulation only", async () => {
    const mock = new MockOwnershipAdapter(MOCK);
    for (const bad of [{ ...REQUEST, assetId: "nope" }, { ...REQUEST, reference: { kind: "epoch", value: 1n } }, { ...REQUEST, reference: { kind: "slot", value: -1n } }, { ...REQUEST, reference: { kind: "slot", value: 1 } }, { ...REQUEST, extra: 1 }])
      expect(await code(() => loadVerifiedOwnershipSnapshot(mock, bad as never))).toBe("invalid_request");
    const real = { adapterId: "real", simulationOnly: false, loadSnapshot: mock.loadSnapshot.bind(mock) } as unknown as IOwnershipSourceAdapter;
    expect(await code(() => loadVerifiedOwnershipSnapshot(real, REQUEST))).toBe("not_simulation_adapter");
    const anonymous = { adapterId: "", simulationOnly: true, loadSnapshot: mock.loadSnapshot.bind(mock) } as IOwnershipSourceAdapter;
    expect(await code(() => loadVerifiedOwnershipSnapshot(anonymous, REQUEST))).toBe("not_simulation_adapter");
  });

  it("refuses snapshots that do not verify, are not frozen, or do not answer the request", async () => {
    const genuine = await new MockOwnershipAdapter(MOCK).loadSnapshot(REQUEST);
    const serving = (s: unknown): IOwnershipSourceAdapter => ({ adapterId: "test", simulationOnly: true, loadSnapshot: async () => s as never });
    const tampered = structuredClone(genuine);
    tampered.entries[0]!.rawShares += 1n;
    expect(await code(() => loadVerifiedOwnershipSnapshot(serving(Object.freeze(tampered)), REQUEST))).toBe("snapshot_invalid");
    const realNetwork = structuredClone(genuine) as unknown as { networkId: string };
    realNetwork.networkId = "solana-mainnet";
    expect(await code(() => loadVerifiedOwnershipSnapshot(serving(realNetwork), REQUEST))).toBe("snapshot_invalid");
    expect(await code(() => loadVerifiedOwnershipSnapshot(serving(structuredClone(genuine)), REQUEST))).toBe("snapshot_invalid"); // a mutable copy
    expect(await code(() => loadVerifiedOwnershipSnapshot(serving({}), REQUEST))).toBe("snapshot_invalid");
    // Genuine, but for another request.
    const mock = new MockOwnershipAdapter(MOCK);
    const answering = (r: OwnershipSnapshotRequest): IOwnershipSourceAdapter => ({ adapterId: "test", simulationOnly: true, loadSnapshot: () => mock.loadSnapshot(r) });
    for (const other of [{ ...REQUEST, assetId: "bc".repeat(32) }, { ...REQUEST, networkId: "solana-localnet" }, { ...REQUEST, reference: { kind: "slot" as const, value: 250_000_001n } }, { ...REQUEST, reference: { kind: "block_height" as const, value: 250_000_000n } }, { ...REQUEST, verifiedAt: "2026-10-02T00:00:00Z" }])
      expect(await code(() => loadVerifiedOwnershipSnapshot(answering(other), REQUEST))).toBe("snapshot_mismatch");
  });
});

describe("FileFixtureOwnershipAdapter", () => {
  it("the committed fixture is exactly the mock's dataset, and loads to the mock's snapshot", async () => {
    const text = readFileSync(FIXTURE, "utf8");
    expect(text).toBe(fixtureText());
    const pinned = await contentHash(text);
    const fromFile = await loadVerifiedOwnershipSnapshot(fileAdapter(new TextEncoder().encode(text), pinned), REQUEST);
    const fromMock = await loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter(MOCK), REQUEST);
    expect(fromFile).toEqual(fromMock);
    // u64 values survive as decimal strings.
    expect(text).toContain(`"${U64_MAX}"`);
  });

  it("serves the PR #75 scenario snapshot with its independent vector hash", async () => {
    const s = await loadVerifiedOwnershipSnapshot(fileAdapter(serializeOwnershipFixture(SNAPSHOT_INPUT)), scenarioRequest);
    expect(s.snapshotHash).toBe("bb57ff8d4fcf9adbfae0d505004022e73cbd1535848641fde2c493bf884d5ddd");
  });

  it("round-trips 1,500 holders through the fixture format with the same commitment", async () => {
    const mock = new MockOwnershipAdapter({ ...MOCK, holders: 1_500, profile: "skewed" });
    const text = serializeOwnershipFixture(mock.inputFor(REQUEST));
    expect(parseOwnershipFixture(text)).toEqual(mock.inputFor(REQUEST));
    expect((await loadVerifiedOwnershipSnapshot(fileAdapter(text), REQUEST)).snapshotHash).toBe((await loadVerifiedOwnershipSnapshot(mock, REQUEST)).snapshotHash);
  });

  it("refuses a fixture whose bytes do not match the pinned hash", async () => {
    const text = serializeOwnershipFixture(SNAPSHOT_INPUT);
    const pinned = await contentHash(text);
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter(text, pinned), scenarioRequest))).toBe("no error");
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter(text.replace('"50"', '"51"'), pinned), scenarioRequest))).toBe("fixture_hash_mismatch");
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter(`${text} `, pinned), scenarioRequest))).toBe("fixture_hash_mismatch");
    expect(await code(() => new FileFixtureOwnershipAdapter({ read: async () => text, expectedSha256: "ABC" }))).toBe("invalid_request");
  });

  it("refuses fixtures that are not strict simulation documents", async () => {
    const variants: [string, (d: ReturnType<typeof fixtureDoc>) => void][] = [
      ["not simulation", (d) => (d.simulation = false)],
      ["other scheme", (d) => (d.scheme = "metafarm-yield-ownership-fixture/2")],
      ["extra top-level key", (d) => (d.signature = "x")],
      ["extra snapshot key", (d) => (d.snapshot.chain = "solana")],
      ["shares as a number", (d) => (d.snapshot.entries[0].rawShares = 50)],
      ["leading zero", (d) => (d.snapshot.entries[0].rawShares = "050")],
      ["negative", (d) => (d.snapshot.entries[0].rawShares = "-50")],
      ["exponent", (d) => (d.snapshot.entries[0].rawShares = "5e1")],
      ["over 20 digits", (d) => (d.snapshot.entries[0].rawShares = "1".repeat(21))],
      ["reference as a number", (d) => (d.snapshot.reference.value = 123456789)],
      ["extra entry key", (d) => (d.snapshot.entries[0].weight = "1")],
      ["entry not an object", (d) => (d.snapshot.entries[0] = "party-a")],
    ];
    for (const [name, mutate] of variants) {
      const d = fixtureDoc();
      mutate(d);
      expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter(JSON.stringify(d)), scenarioRequest)), name).toBe("invalid_fixture");
    }
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter("{"), scenarioRequest))).toBe("invalid_fixture");
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter(new Uint8Array([0xff, 0xfe])), scenarioRequest))).toBe("invalid_fixture");
    expect(await code(() => loadVerifiedOwnershipSnapshot(fileAdapter("[]"), scenarioRequest))).toBe("invalid_fixture");
  });

  it("passes fixture contents to the snapshot verifier: real networks, unsorted and over-u64 shares are refused", async () => {
    const withDoc = async (mutate: (d: ReturnType<typeof fixtureDoc>) => void) => {
      const d = fixtureDoc();
      mutate(d);
      return code(() => loadVerifiedOwnershipSnapshot(fileAdapter(JSON.stringify(d)), scenarioRequest));
    };
    for (const networkId of ["solana-mainnet", "mainnet-beta", "tron"]) expect(await withDoc((d) => (d.snapshot.networkId = networkId)), networkId).toBe("real_network");
    expect(await withDoc((d) => d.snapshot.entries.reverse())).toBe("not_canonical_order");
    expect(await withDoc((d) => (d.snapshot.entries[0].rawShares = (U64_MAX + 1n).toString()))).toBe("invalid_shares");
    expect(await withDoc((d) => (d.snapshot.entries[0].rawShares = "0"))).toBe("invalid_shares");
    expect(await withDoc((d) => (d.snapshot.entries[1].partyId = "party-a"))).toBe("duplicate_party");
    // A fixture for another reference does not answer the request.
    expect(await withDoc((d) => (d.snapshot.reference.value = "123456790"))).toBe("snapshot_mismatch");
  });

  it("will not write a fixture naming a real network", async () => {
    expect(await code(() => serializeOwnershipFixture({ ...SNAPSHOT_INPUT, networkId: "solana-mainnet" }))).toBe("real_network");
  });
});
