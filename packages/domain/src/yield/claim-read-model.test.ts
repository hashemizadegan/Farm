/**
 * Claim read model: round-trip persistence and single-holder queries at 4,096 and 16,384 holders, read
 * accounting, and fail-closed behaviour. No network or storage I/O (images are in-memory bytes).
 *
 * To regenerate the C# sample after a deliberate change: write `await claimReadModelSampleText()` to
 * clients/unity-starter/Samples/claim-readmodel.sample.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ClaimTreeHasher, SHA256_RFC9162_HASHER, decodeClaimLeaf } from "./claim-tree";
import { type ClaimLookup, type ClaimPayloadDto, type PublishedClaimTree, createClaimLookup, verifyClaimPayload } from "./claim-lookup";
import { type ClaimReadModel, type ClaimReadModelError, InMemoryClaimReadModelStore, decodeReadModelImage, encodeReadModelImage, openClaimReadModel, projectClaimReadModel, readModelKeys } from "./claim-read-model";
import type { CycleDistributionArtifact } from "./pipeline";
import { contentHash } from "../twin/commitments";
import { SHARED_16K, countingHasher, largeTreeSample, pickParties, sharedCycle16k } from "./large-holder.test-support";
import { claimReadModelSampleText, sampleReadModel } from "./claim-read-model.sample.test-support";
import { unhex } from "./pipeline.scenario.test-support";

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples/claim-readmodel.sample.json");
const H = SHA256_RFC9162_HASHER;
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as ClaimReadModelError).code ?? (e as Error).name;
  }
  return "no error";
};
const expectedOf = (a: CycleDistributionArtifact, sha: string) => ({ cycleId: a.cycle.id, cycleVersion: a.cycle.version, artifactSha256: sha });
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** A copy of a store with one record replaced (or removed with null). */
async function edited(store: InMemoryClaimReadModelStore, key: string, value: string | null) {
  const out = new InMemoryClaimReadModelStore();
  for (const [k, v] of store.entries()) if (k !== key) await out.put(k, v);
  if (value !== null) await out.put(key, value);
  return out;
}

/** Projects, persists and reloads; checks the image round trip and the exact record count. */
async function persist(r: { artifact: CycleDistributionArtifact; artifactSha256: string }, hasher: ClaimTreeHasher = H) {
  const store = new InMemoryClaimReadModelStore();
  const header = await projectClaimReadModel(r.artifact, r.artifactSha256, hasher, store);
  const image = await encodeReadModelImage(store);
  const loaded = await decodeReadModelImage(image.bytes, image.sha256);
  // Persistence round trip: the reloaded store re-encodes to the same bytes.
  const again = await encodeReadModelImage(loaded);
  expect(again.sha256).toBe(image.sha256);
  // Compared byte by byte: a deep toEqual over a multi-megabyte typed array enumerates every index.
  expect(sameBytes(again.bytes, image.bytes)).toBe(true);
  // Exact record count: header, holders, unattributed, recipient index, leaves, nodes.
  const plan = r.artifact.distribution.plan;
  const withWallet = plan.entries.filter((e) => e.kind === "party" && e.payoutWallet !== null).length;
  expect(loaded.size).toBe(1 + header.summary.counts.parties + header.summary.counts.unattributed + withWallet + header.summary.counts.leaves + header.levelSizes.reduce((a, b) => a + b, 0));
  // Level sizes follow from the tree size: L, ⌈L/2⌉, …, 1.
  expect(header.levelSizes[0]).toBe(r.artifact.claimTree!.size);
  expect(header.levelSizes.length - 1).toBe(Math.ceil(Math.log2(r.artifact.claimTree!.size)));
  return { header, image, loaded };
}

/**
 * Checks the given holders against the in-memory lookup: same result by party id and by payout address,
 * exactly 2 + path reads per claim and 1 otherwise, at most 2 KB read per claim. Returns the state counts.
 */
async function crossCheck(model: ClaimReadModel, loaded: InMemoryClaimReadModelStore, lookup: ClaimLookup, holders: readonly { partyId: string; payoutAddress: string | null }[], unattributed: readonly string[]) {
  const states: Record<string, number> = {};
  let maxClaimBytes = 0;
  for (const e of holders) {
    const b = { ...loaded.stats };
    const got = await model.byPartyId(e.partyId);
    expect(got).toEqual(lookup.byPartyId(e.partyId));
    const gets = loaded.stats.gets - b.gets;
    const key = got.status === "no_leaf" ? (got.reason === "deferred" ? got.deferredReason : got.reason) : got.status;
    states[key] = (states[key] ?? 0) + 1;
    if (got.status === "claim") {
      expect(gets).toBe(2 + got.claim.path.length);
      expect(gets).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(got.claim.treeSize)));
      maxClaimBytes = Math.max(maxClaimBytes, loaded.stats.bytesRead - b.bytesRead);
    } else expect(gets).toBe(1);
    if (e.payoutAddress !== null) expect(await model.byPayoutAddress(e.payoutAddress)).toEqual(lookup.byPayoutAddress(e.payoutAddress));
  }
  // A single-holder claim lookup reads about 1.5 KB, independent of the cycle's size (bounded by the path).
  expect(maxClaimBytes).toBeLessThanOrEqual(2_048);
  for (const u of unattributed) expect(await model.byPartyId(u)).toEqual({ status: "unattributed" });
  for (const nobody of ["nobody", "", "holder-999999"]) expect(await model.byPartyId(nobody)).toEqual(lookup.byPartyId(nobody));
  expect(await model.byPayoutAddress("ff".repeat(32))).toEqual({ status: "not_in_cycle" });
  expect(await model.byPayoutAddress("not-an-address")).toEqual({ status: "not_in_cycle" });
  return states;
}

describe("4,096 holders: full cross-check", () => {
  it("pinned image; every holder's result equals the in-memory lookup; header + 2 + path reads per claim", async () => {
    const { artifact, artifactSha256, ownership, image } = await sampleReadModel();
    expect({ sha256: image.sha256, bytes: image.bytes.length }).toEqual({ sha256: "79f1704fbadc3ddedc94e5a2133a4592c317448f86015f95c3767899a446377f", bytes: 4_067_466 });
    const { header, loaded } = await persist({ artifact, artifactSha256 });
    expect(header.summary.counts.parties).toBe(4_096);
    expect(header.summary.totals.inflow).toBe(artifact.totals.inflow.toString());
    const before = loaded.stats.gets;
    const model = await openClaimReadModel(loaded, expectedOf(artifact, artifactSha256), H);
    expect(loaded.stats.gets - before).toBe(1); // opening reads the header only
    const lookup = await createClaimLookup(artifact, artifactSha256, H);
    expect(model.published).toEqual(lookup.published);
    const states = await crossCheck(model, loaded, lookup, ownership.entries, ownership.unattributed.map((u) => u.holderKey));
    expect(Object.values(states).reduce((a, b) => a + b, 0)).toBe(4_096); // every holder
    // Paging by leaf index gives the lookup's claims, with exact layout 2 leaves.
    const all = lookup.all();
    for (const i of [0, 1, Math.floor(all.length / 2), all.length - 1]) {
      const c = await model.claimAt(i);
      expect(c).toEqual(all[i]);
      const leaf = await decodeClaimLeaf(unhex(c.leafBytes));
      expect([leaf.leafLayoutVersion, leaf.leafIndex, leaf.amount.toString()]).toEqual([2, i, c.amount]);
    }
  }, 600_000);
});

// ── 16,384 holders: invariants, exact cost envelopes and a seeded subset ─────────────────────────

/** Fixed inputs: seed, holders and a dust threshold of 1,000 base units, so every holder state occurs. */
const BIG = { ...SHARED_16K, subsetSize: 1_024, subsetSeed: 0x5b5e7n } as const;
// Pinned for those inputs: any change to the projection or the image format shows here.
const PINNED_16K = { sha256: "4c0ff4580f04658b06fb9e5893d970716c2a41245aed67b1ac60e859214fdffa", bytes: 16_412_652 };
// The seeded pick of 1,024 misses the rare below-threshold state, so its first holder is added.
const PINNED_SUBSET: [string, string, string[]] = ["holder-000004", "holder-016380", ["below_dust_threshold"]];

let bigState: ReturnType<typeof buildBig> | undefined;
async function buildBig() {
  // The 16,384-holder cycle shared with the #78 envelope tests (memoized in-process, deeply frozen).
  const r = await sharedCycle16k();
  const projection = countingHasher();
  const persisted = await persist(r, projection);
  return { ...r, projection: projection.counts, ...persisted };
}
const big = () => (bigState ??= buildBig());

type Category = "claim" | "withheld" | "zero_amount" | "below_dust_threshold";
const categoryOf = (e: CycleDistributionArtifact["distribution"]["plan"]["entries"][number]): Category | null =>
  e.kind !== "party" ? null : e.state === "payable" ? "claim" : e.state === "withheld" ? "withheld" : e.state === "deferred" ? e.deferredReason ?? "below_dust_threshold" : null;

/**
 * The seeded subset: `subsetSize` holders picked by splitMix64(subsetSeed), plus, for any holder state the
 * pick missed, the first holder of that state in party-id order. Same inputs, same subset.
 */
function seededSubset(artifact: CycleDistributionArtifact, ownership: { entries: readonly { partyId: string; payoutAddress: string | null }[] }) {
  const picked = new Set(pickParties(ownership.entries.map((e) => e.partyId), BIG.subsetSize, BIG.subsetSeed));
  const category = new Map(artifact.distribution.plan.entries.map((e) => [e.partyId, categoryOf(e)]));
  const forced: Category[] = [];
  for (const want of ["claim", "withheld", "zero_amount", "below_dust_threshold"] as const) {
    if ([...picked].some((p) => category.get(p) === want)) continue;
    const first = ownership.entries.find((e) => category.get(e.partyId) === want);
    if (first) {
      picked.add(first.partyId);
      forced.push(want);
    }
  }
  return { holders: ownership.entries.filter((e) => picked.has(e.partyId)), forced };
}

describe("16,384 holders: invariants, cost envelopes, seeded subset", () => {
  it("image: pinned SHA-256 and byte size, identical after a round trip, exact record and level counts", async () => {
    const { image } = await big();
    expect({ sha256: image.sha256, bytes: image.bytes.length }).toEqual(PINNED_16K);
  }, 600_000);

  it("hash calls: projection costs exactly L leaf and Σpath + (L − 1) node hashes; each served claim exactly 1 + path", async () => {
    const { artifact, artifactSha256, projection, loaded, ownership } = await big();
    const leaves = artifact.claimTree!.leaves;
    const L = leaves.length;
    const pathSum = leaves.reduce((n, l) => n + l.proof.path.length, 0);
    // Artifact re-verification (every proof once) plus the tree levels (L − 1 interior nodes).
    expect(projection).toEqual({ leaf: L, node: pathSum + (L - 1) });
    const verify = countingHasher();
    const model = await openClaimReadModel(loaded, expectedOf(artifact, artifactSha256), verify);
    expect(verify.counts).toEqual({ leaf: 0, node: 0 }); // opening hashes nothing
    let claims = 0;
    let nodes = 0;
    for (const e of seededSubset(artifact, ownership).holders) {
      const r = await model.byPartyId(e.partyId);
      if (r.status !== "claim") continue;
      claims++;
      nodes += r.claim.path.length;
    }
    expect(claims).toBeGreaterThan(256);
    expect(verify.counts).toEqual({ leaf: claims, node: nodes });
    expect(nodes / claims).toBeLessThanOrEqual(Math.ceil(Math.log2(L)));
  }, 600_000);

  it("seeded subset of 1,024 holders: equal to the in-memory lookup, every holder state covered, reads bounded", async () => {
    const { artifact, artifactSha256, ownership, loaded } = await big();
    const { holders, forced } = seededSubset(artifact, ownership);
    // Stable across runs: fixed seed and inputs give the same subset (pinned by its first and last holders).
    expect(holders.length).toBe(BIG.subsetSize + forced.length);
    expect([holders[0]!.partyId, holders[holders.length - 1]!.partyId, forced]).toEqual(PINNED_SUBSET);
    const before = loaded.stats.gets;
    const model = await openClaimReadModel(loaded, expectedOf(artifact, artifactSha256), H);
    expect(loaded.stats.gets - before).toBe(1); // header only
    const lookup = await createClaimLookup(artifact, artifactSha256, H);
    const states = await crossCheck(model, loaded, lookup, holders, ownership.unattributed.map((u) => u.holderKey));
    for (const c of ["claim", "withheld", "zero_amount", "below_dust_threshold"]) expect(states[c] ?? 0, c).toBeGreaterThan(0);
    expect(Object.values(states).reduce((a, b) => a + b, 0)).toBe(holders.length);
  }, 600_000);

  it("fails closed on tampering in the 16,384-holder store", async () => {
    const { artifact, artifactSha256, loaded } = await big();
    const expected = expectedOf(artifact, artifactSha256);
    const k = readModelKeys(expected.cycleId, expected.cycleVersion);
    const leaves = artifact.claimTree!.leaves;
    const target = leaves[leaves.length - 1]!; // the deepest-indexed leaf
    const other = leaves[1]!;
    const open = async (s: InMemoryClaimReadModelStore) => openClaimReadModel(s, expected, H);
    const leafRec = JSON.parse((await loaded.get(k.leaf(target.leafIndex)))!) as Record<string, string>;
    expect(await code(async () => (await open(await edited(loaded, k.leaf(target.leafIndex), JSON.stringify({ ...leafRec, amount: "1" })))).byPartyId(target.partyId))).toBe("corrupt");
    // Nodes on a mid-tree leaf's full-depth path, at the leaf level and two interior levels.
    const mid = leaves[5_000]!;
    for (const level of [0, 1, 7]) expect(await code(async () => (await open(await edited(loaded, k.node(level, (mid.leafIndex >> level) ^ 1), "0".repeat(64)))).byPartyId(mid.partyId)), `level ${level}`).toBe("corrupt");
    expect(await code(async () => (await open(await edited(loaded, k.party(target.partyId), JSON.stringify({ leafIndex: other.leafIndex, status: "claim" })))).byPartyId(target.partyId))).toBe("corrupt");
    expect(await code(async () => (await open(await edited(loaded, k.recipient(target.recipient), JSON.stringify({ partyId: other.partyId })))).byPayoutAddress(target.recipient))).toBe("corrupt");
    const header = JSON.parse((await loaded.get(k.header))!) as Record<string, unknown>;
    expect(await code(async () => open(await edited(loaded, k.header, JSON.stringify({ ...header, networkId: "solana-mainnet" }))))).toBe("real_network");
    expect(await code(async () => open(await edited(loaded, k.header, JSON.stringify({ ...header, simulation: false }))))).toBe("simulation_only");
    const { image } = await big();
    const flipped = new Uint8Array(image.bytes);
    flipped[Math.floor(flipped.length / 2)] = flipped[Math.floor(flipped.length / 2)]! ^ 1;
    expect(await code(() => decodeReadModelImage(flipped, image.sha256))).toBe("image_hash_mismatch");
  }, 600_000);
});

describe("fail closed", () => {
  it("projection refuses non-simulation, unverifiable and real-network artifacts, and writing twice", async () => {
    const { artifact, artifactSha256 } = await sampleReadModel();
    const real = structuredClone(artifact);
    real.cycle.simulation = false;
    expect(await code(() => projectClaimReadModel(real, artifactSha256, H, new InMemoryClaimReadModelStore()))).toBe("simulation_only");
    const mainnet = structuredClone(artifact) as unknown as { ownership: { networkId: string } };
    mainnet.ownership.networkId = "solana-mainnet";
    expect(await code(() => projectClaimReadModel(mainnet as never, artifactSha256, H, new InMemoryClaimReadModelStore()))).toBe("real_network");
    expect(await code(() => projectClaimReadModel(artifact, "0".repeat(64), H, new InMemoryClaimReadModelStore()))).toBe("artifact_invalid");
    const store = new InMemoryClaimReadModelStore();
    await projectClaimReadModel(artifact, artifactSha256, H, store);
    expect(await code(() => projectClaimReadModel(artifact, artifactSha256, H, store))).toBe("duplicate_key");
  }, 600_000);

  it("opening refuses a missing, mismatched, non-simulation, real-network or inconsistent header", async () => {
    const { artifact, artifactSha256, store } = await sampleReadModel();
    const expected = expectedOf(artifact, artifactSha256);
    const k = readModelKeys(expected.cycleId, expected.cycleVersion);
    const header = JSON.parse((await store.get(k.header))!) as Record<string, unknown>;
    const withHeader = (patch: Record<string, unknown>) => edited(store, k.header, JSON.stringify({ ...header, ...patch }));
    expect(await code(() => openClaimReadModel(new InMemoryClaimReadModelStore(), expected, H))).toBe("not_found");
    expect(await code(() => openClaimReadModel(store, { ...expected, artifactSha256: "1".repeat(64) }, H))).toBe("header_mismatch");
    expect(await code(() => openClaimReadModel(store, expected, { ...H, id: "other" }))).toBe("header_mismatch");
    expect(await code(async () => openClaimReadModel(await withHeader({ simulation: false }), expected, H))).toBe("simulation_only");
    for (const networkId of ["solana-mainnet", "mainnet-beta", "tron"]) expect(await code(async () => openClaimReadModel(await withHeader({ networkId }), expected, H)), networkId).toBe("real_network");
    expect(await code(async () => openClaimReadModel(await withHeader({ levelSizes: [1] }), expected, H))).toBe("corrupt");
    expect(await code(async () => openClaimReadModel(await withHeader({ scheme: "other" }), expected, H))).toBe("corrupt");
    expect(await code(async () => openClaimReadModel(await edited(store, k.header, "not json"), expected, H))).toBe("corrupt");
  }, 600_000);

  it("queries refuse tampered leaves, nodes and index records instead of serving unverified claims", async () => {
    const { artifact, artifactSha256, store } = await sampleReadModel();
    const expected = expectedOf(artifact, artifactSha256);
    const k = readModelKeys(expected.cycleId, expected.cycleVersion);
    const leaves = artifact.claimTree!.leaves;
    const target = leaves[100]!;
    const other = leaves[200]!;
    const open = async (s: InMemoryClaimReadModelStore) => openClaimReadModel(s, expected, H);
    // A leaf record whose amount (and bytes) were changed.
    const leafRec = JSON.parse((await store.get(k.leaf(target.leafIndex)))!) as Record<string, string>;
    const bumped = { ...leafRec, amount: (BigInt(leafRec.amount!) + 1n).toString() };
    expect(await code(async () => (await open(await edited(store, k.leaf(target.leafIndex), JSON.stringify(bumped)))).byPartyId(target.partyId))).toBe("corrupt");
    // A sibling node on the target's path.
    const sibling = k.node(0, target.leafIndex ^ 1);
    expect(await code(async () => (await open(await edited(store, sibling, "f".repeat(64)))).byPartyId(target.partyId))).toBe("corrupt");
    expect(await code(async () => (await open(await edited(store, sibling, null))).byPartyId(target.partyId))).toBe("corrupt");
    // A holder record pointing at another party's leaf.
    expect(await code(async () => (await open(await edited(store, k.party(target.partyId), JSON.stringify({ leafIndex: other.leafIndex, status: "claim" })))).byPartyId(target.partyId))).toBe("corrupt");
    // A recipient index pointing at another party: the claim's recipient would not be the address asked for.
    expect(await code(async () => (await open(await edited(store, k.recipient(target.recipient), JSON.stringify({ partyId: other.partyId })))).byPayoutAddress(target.recipient))).toBe("corrupt");
    // A malformed holder record.
    expect(await code(async () => (await open(await edited(store, k.party(target.partyId), JSON.stringify({ status: "paid" })))).byPartyId(target.partyId))).toBe("corrupt");
    // Untouched holders are still served.
    expect((await (await open(await edited(store, sibling, "f".repeat(64)))).byPartyId(other.partyId)).status).toBe("claim");
  }, 600_000);

  it("images: refuses a changed byte, a wrong hash, unsorted, duplicate or non-canonical lines and a wrong count", async () => {
    const { image } = await sampleReadModel();
    const flipped = new Uint8Array(image.bytes);
    flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 1;
    expect(await code(() => decodeReadModelImage(flipped, image.sha256))).toBe("image_hash_mismatch");
    const text = new TextDecoder().decode(image.bytes);
    const lines = text.slice(0, -1).split("\n");
    const rebuild = async (ls: string[]) => {
      const bytes = new TextEncoder().encode(`${ls.join("\n")}\n`);
      return code(async () => decodeReadModelImage(bytes, await contentHash(bytes)));
    };
    expect(await rebuild([lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)])).toBe("invalid_image");
    expect(await rebuild([lines[0]!.replace(/"records":\d+/, `"records":${lines.length}`), ...lines.slice(1), lines[1]!])).toBe("invalid_image");
    expect(await rebuild([lines[0]!, lines[1]!.replace('","', '", "'), ...lines.slice(2)])).toBe("invalid_image");
    expect(await rebuild(lines.slice(0, -1))).toBe("invalid_image");
    expect(await rebuild([lines[0]!.replace("read-model-image/1", "read-model-image/2"), ...lines.slice(1)])).toBe("invalid_image");
  }, 600_000);
});

describe("read-model sample shared with C#", () => {
  it("the committed file is exactly what the read model serves", async () => {
    expect(readFileSync(SAMPLE, "utf8")).toBe(await claimReadModelSampleText());
  }, 600_000);

  it("its claims equal the #78 large-tree sample's claims for the same parties and verify", async () => {
    const s = JSON.parse(readFileSync(SAMPLE, "utf8")) as { header: { published: PublishedClaimTree }; claims: ClaimPayloadDto[]; reads: { gets: number }[] };
    const large = await largeTreeSample();
    expect(s.claims).toEqual(large.claims);
    expect(s.header.published).toEqual(large.publishedTree);
    for (const [i, c] of s.claims.entries()) {
      expect(await verifyClaimPayload(c, s.header.published, H)).toBe(true);
      expect(s.reads[i]!.gets).toBe(2 + c.path.length);
    }
  }, 600_000);
});
