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
import { SHA256_RFC9162_HASHER, decodeClaimLeaf } from "./claim-tree";
import { type ClaimLookup, type ClaimPayloadDto, type PublishedClaimTree, createClaimLookup, verifyClaimPayload } from "./claim-lookup";
import { type ClaimReadModelError, InMemoryClaimReadModelStore, decodeReadModelImage, encodeReadModelImage, openClaimReadModel, projectClaimReadModel, readModelKeys } from "./claim-read-model";
import type { CycleDistributionArtifact } from "./pipeline";
import { contentHash } from "../twin/commitments";
import { largeHolderCycle, largeTreeSample } from "./large-holder.test-support";
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

let big: Promise<Awaited<ReturnType<typeof largeHolderCycle>>> | undefined;
const cycle16k = () => (big ??= largeHolderCycle(16_384, 0xe17e10e5n));

/** Projects, persists, reloads, and checks every holder against the in-memory lookup. */
async function roundTrip(r: { artifact: CycleDistributionArtifact; artifactSha256: string; ownership: { entries: readonly { partyId: string; payoutAddress: string | null }[]; unattributed: readonly { holderKey: string }[] } }) {
  const store = new InMemoryClaimReadModelStore();
  const header = await projectClaimReadModel(r.artifact, r.artifactSha256, H, store);
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

  const stats0 = { ...loaded.stats };
  const model = await openClaimReadModel(loaded, expectedOf(r.artifact, r.artifactSha256), H);
  expect(loaded.stats.gets - stats0.gets).toBe(1); // opening reads the header only
  const lookup: ClaimLookup = await createClaimLookup(r.artifact, r.artifactSha256, H);
  expect(model.published).toEqual(lookup.published);

  // Every holder: same result as the in-memory lookup, with exactly 2 + path reads per claim and 1 otherwise.
  let expectedGets = 0;
  let maxClaimBytes = 0;
  const before = { ...loaded.stats };
  for (const e of r.ownership.entries) {
    const b = { ...loaded.stats };
    const got = await model.byPartyId(e.partyId);
    expect(got).toEqual(lookup.byPartyId(e.partyId));
    const gets = loaded.stats.gets - b.gets;
    if (got.status === "claim") {
      expect(gets).toBe(2 + got.claim.path.length);
      maxClaimBytes = Math.max(maxClaimBytes, loaded.stats.bytesRead - b.bytesRead);
    } else expect(gets).toBe(1);
    expectedGets += gets;
  }
  expect(loaded.stats.gets - before.gets).toBe(expectedGets);
  // A single-holder claim lookup reads about 1.6 KB, independent of the cycle's size (bounded by the path).
  expect(maxClaimBytes).toBeLessThanOrEqual(2_048);
  for (const e of r.ownership.entries.filter((x) => x.payoutAddress !== null)) expect(await model.byPayoutAddress(e.payoutAddress!)).toEqual(lookup.byPayoutAddress(e.payoutAddress!));
  for (const u of r.ownership.unattributed) expect(await model.byPartyId(u.holderKey)).toEqual({ status: "unattributed" });
  for (const nobody of ["nobody", "", "holder-999999"]) expect(await model.byPartyId(nobody)).toEqual(lookup.byPartyId(nobody));
  expect(await model.byPayoutAddress("ff".repeat(32))).toEqual({ status: "not_in_cycle" });
  expect(await model.byPayoutAddress("not-an-address")).toEqual({ status: "not_in_cycle" });
  // Paging by leaf index gives the lookup's claims, with exact layout 2 leaves.
  const all = lookup.all();
  for (const i of [0, 1, Math.floor(all.length / 2), all.length - 1]) {
    const c = await model.claimAt(i);
    expect(c).toEqual(all[i]);
    const leaf = await decodeClaimLeaf(unhex(c.leafBytes));
    expect([leaf.leafLayoutVersion, leaf.leafIndex, leaf.amount.toString()]).toEqual([2, i, c.amount]);
  }
  return { header, image, loaded, model };
}

describe("round-trip persistence and queries", () => {
  it("4,096 holders: pinned image; every holder's result equals the in-memory lookup; 2 + path reads per claim", async () => {
    const { artifact, artifactSha256, ownership, image } = await sampleReadModel();
    expect({ sha256: image.sha256, bytes: image.bytes.length }).toEqual({ sha256: "79f1704fbadc3ddedc94e5a2133a4592c317448f86015f95c3767899a446377f", bytes: 4_067_466 });
    const { header } = await roundTrip({ artifact, artifactSha256, ownership });
    expect(header.summary.counts.parties).toBe(4_096);
    expect(header.summary.totals.inflow).toBe(artifact.totals.inflow.toString());
  }, 600_000);

  it("16,384 holders: same guarantees; per-claim reads grow only with the path (≤ 2 + 14)", async () => {
    const r = await cycle16k();
    const { header, model, loaded } = await roundTrip(r);
    expect(header.levelSizes[0]).toBe(r.artifact.claimTree!.size);
    expect(header.levelSizes.length - 1).toBe(Math.ceil(Math.log2(r.artifact.claimTree!.size)));
    const last = r.artifact.claimTree!.leaves[r.artifact.claimTree!.size - 1]!;
    const before = loaded.stats.gets;
    await model.byPartyId(last.partyId);
    expect(loaded.stats.gets - before).toBeLessThanOrEqual(2 + 14);
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
