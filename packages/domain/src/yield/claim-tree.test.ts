import { describe, expect, it } from "vitest";
import { merkleAuditPath, merkleLeaf, merkleRoot, verifyMerkleInclusion } from "../twin/commitments";
import type { YieldAmountError } from "./amounts";
import {
  CLAIM_LEAF_BYTES,
  type ClaimLeafContext,
  type ClaimTreeError,
  type ClaimTreeHasher,
  SHA256_RFC9162_HASHER,
  SIMULATION_CLAIM_TREE_POLICY,
  buildClaimTree,
  claimLeafDomainTag,
  claimTreePolicyProblems,
  decodeClaimLeaf,
  decodeKey32,
  encodeClaimLeaf,
  merkleTreeOverLeafBytes,
  verifyClaimLeafProof,
  verifyClaimProof,
} from "./claim-tree";
import { type DistributionShare, SIMULATION_DISTRIBUTION_POLICY, emptyDistributionLedger, planDistribution } from "./distribution";
import { YieldRecordError } from "./records";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
const sha = async (b: Uint8Array) => hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(b))));
const WSOL = "So11111111111111111111111111111111111111112";
const cycle = { id: "00000000-0000-4000-8000-00000000000a", version: 1, simulation: true };
const context: ClaimLeafContext = { networkId: 7, clusterIdentity: "aa".repeat(32), epoch: 0, economicAssetId: "bb".repeat(32), payoutMint: WSOL, formulaVersion: 1 };
const party = (partyId: string, weight: bigint, payoutWallet: string | null): DistributionShare => ({ kind: "party", partyId, payoutWallet, weight });
const plan = (shares: DistributionShare[], ndy: bigint, c = cycle, policy = SIMULATION_DISTRIBUTION_POLICY) => planDistribution({ cycle: c, policy, netDistributableYield: ndy, shares, ledger: emptyDistributionLedger() });
const exampleF = () => plan([party("c", 1n, "03".repeat(32)), party("a", 1n, "01".repeat(32)), party("b", 1n, "02".repeat(32))], 1_000_000n);
const build = (p = exampleF(), patch: Partial<Parameters<typeof buildClaimTree>[0]> = {}) => buildClaimTree({ plan: p, policy: SIMULATION_CLAIM_TREE_POLICY, hasher: SHA256_RFC9162_HASHER, context, ...patch });
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as ClaimTreeError | YieldAmountError).code ?? (e as Error).name;
  }
  return "no error";
};

describe("keys and leaf encoding (plan §6.2)", () => {
  it("decodes Solana base58 addresses and 64-hex keys to exactly 32 bytes", () => {
    expect(hex(decodeKey32("k", WSOL))).toBe("069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001"); // Python base58
    expect(hex(decodeKey32("k", "11111111111111111111111111111111"))).toBe("00".repeat(32));
    expect(hex(decodeKey32("k", "ab".repeat(32)))).toBe("ab".repeat(32));
  });

  it("refuses keys that are not exactly 32 bytes or not base58/hex", async () => {
    for (const k of ["", "0OIl", "1111", WSOL + "1", "AB".repeat(32), "ab".repeat(31), 42]) expect(await code(() => decodeKey32("k", k)), String(k)).toBe("invalid_key");
  });

  it("encodes 201 bytes that match an independent Python vector, and decodes them back", async () => {
    expect(hex(await claimLeafDomainTag())).toBe("8f24147acb60304b34971e8fea956387add8a1280ee6342be62679269a959a83");
    const fields = {
      networkId: 7,
      clusterIdentity: unhex("aa".repeat(32)),
      cycleId: unhex("0000000000004000800000000000000a"),
      cycleVersion: 1,
      epoch: 0,
      economicAssetId: unhex("bb".repeat(32)),
      recipient: unhex("01".repeat(32)),
      payoutMint: decodeKey32("mint", WSOL),
      amount: 333_334n,
      formulaVersion: 1,
      leafLayoutVersion: 1,
      leafIndex: 0,
    };
    const bytes = await encodeClaimLeaf(fields);
    expect(bytes.length).toBe(CLAIM_LEAF_BYTES);
    expect(await sha(bytes)).toBe("4df795744de3f32e15c757378ea3b2ecbb4a42e0992e402f3b1408bb530ebfc3");
    expect(hex(await SHA256_RFC9162_HASHER.leaf(bytes))).toBe("b9625d4c861a19f61cc4c4180dfb6a5489d90abf4d1103630b2e0be4edd1f1c5");
    expect(await decodeClaimLeaf(bytes)).toEqual(fields);
  });

  it("refuses amounts outside 0 < amount ≤ u64, wrong field sizes and integer overflow", async () => {
    const base = await decodeClaimLeaf(unhex((await build()).leaves[0]!.leafBytes));
    expect(await code(() => encodeClaimLeaf({ ...base, amount: 0n }))).toBe("amount_out_of_range");
    expect(await code(() => encodeClaimLeaf({ ...base, amount: 2n ** 64n }))).toBe("amount_out_of_range");
    expect(await code(() => encodeClaimLeaf({ ...base, amount: 2n ** 64n - 1n }))).toBe("no error");
    expect(await code(() => encodeClaimLeaf({ ...base, recipient: new Uint8Array(31) }))).toBe("invalid_input");
    expect(await code(() => encodeClaimLeaf({ ...base, networkId: 256 }))).toBe("invalid_input");
    expect(await code(() => encodeClaimLeaf({ ...base, leafIndex: 2 ** 32 }))).toBe("invalid_input");
    expect(await code(() => encodeClaimLeaf({ ...base, formulaVersion: -1 }))).toBe("invalid_input");
  });

  it("refuses leaves with another domain tag or layout version", async () => {
    const bytes = unhex((await build()).leaves[0]!.leafBytes);
    const badTag = new Uint8Array(bytes);
    badTag[0] = badTag[0]! ^ 1;
    expect(await code(() => decodeClaimLeaf(badTag))).toBe("invalid_input");
    const badLayout = new Uint8Array(bytes);
    badLayout[195] = 2;
    expect(await code(() => decodeClaimLeaf(badLayout))).toBe("invalid_input");
    expect(await code(() => decodeClaimLeaf(bytes.slice(1)))).toBe("invalid_input");
  });

  it("keeps layouts 1 and 2 apart (owner-approved layout 2: layout 1's 201 bytes + 32-byte snapshot hash)", async () => {
    const v1 = unhex((await build()).leaves[0]!.leafBytes);
    const snapshotHash = "5a".repeat(32);
    const t2 = await build(exampleF(), { policy: { ...SIMULATION_CLAIM_TREE_POLICY, leafLayoutVersion: 2 }, context: { ...context, ownershipSnapshotHash: snapshotHash } });
    const v2 = unhex(t2.leaves[0]!.leafBytes);
    expect([v1.length, v2.length]).toEqual([CLAIM_LEAF_BYTES, 233]);
    // Byte-identical to layout 1 except the layout byte (offset 195), then the appended hash.
    const diff = [...v1].flatMap((b, i) => (b === v2[i] ? [] : [i]));
    expect(diff).toEqual([195]);
    expect([v1[195], v2[195]]).toEqual([1, 2]);
    expect(hex(v2.slice(CLAIM_LEAF_BYTES))).toBe(snapshotHash);
    const f2 = await decodeClaimLeaf(v2);
    expect(hex(f2.ownershipSnapshotHash!)).toBe(snapshotHash);
    expect(hex(await encodeClaimLeaf(f2))).toBe(hex(v2));
    // Fail closed on layout confusion: wrong length for the layout byte, either way.
    expect(await code(() => decodeClaimLeaf(v2.slice(0, CLAIM_LEAF_BYTES)))).toBe("invalid_input");
    const relabelled = new Uint8Array(v2);
    relabelled[195] = 1;
    expect(await code(() => decodeClaimLeaf(relabelled))).toBe("invalid_input");
    expect(await code(() => decodeClaimLeaf(new Uint8Array([...v1, ...new Uint8Array(32)])))).toBe("invalid_input");
    // Layout 2 needs its hash; layout 1 refuses one; the tree builder enforces the same.
    expect(await code(() => encodeClaimLeaf({ ...f2, ownershipSnapshotHash: undefined }))).toBe("invalid_input");
    expect(await code(() => encodeClaimLeaf({ ...f2, leafLayoutVersion: 1 }))).toBe("invalid_input");
    expect(await code(() => build(exampleF(), { policy: { ...SIMULATION_CLAIM_TREE_POLICY, leafLayoutVersion: 2 } }))).toBe("invalid_input");
    expect(await code(() => build(exampleF(), { context: { ...context, ownershipSnapshotHash: snapshotHash } }))).toBe("invalid_input");
    // The snapshot hash is committed: changing it changes the leaf hash and the root.
    const t2b = await build(exampleF(), { policy: { ...SIMULATION_CLAIM_TREE_POLICY, leafLayoutVersion: 2 }, context: { ...context, ownershipSnapshotHash: "5b".repeat(32) } });
    expect(t2b.root).not.toBe(t2.root);
  });
});

describe("claim tree of a distribution plan", () => {
  it("F: three leaves ordered by recipient, root matching an independent Python vector, every proof verifying", async () => {
    const t = await build();
    expect(t.leaves.map((l) => [l.partyId, l.amount, l.leafIndex])).toEqual([
      ["a", 333_334n, 0],
      ["b", 333_333n, 1],
      ["c", 333_333n, 2],
    ]);
    expect(t.root).toBe("fdf4e869df7502594d19e3c4cb827b83d6d69110b87b8c56a303ff5016dd54e1");
    for (const l of t.leaves) expect(await verifyClaimProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), l.proof)).toBe(true);
  });

  it("gives only payable entries a leaf, and is independent of share order", async () => {
    const shares = [party("p1", 5n, "01".repeat(32)), party("held", 5n, null), { kind: "unattributed", holderKey: "u", weight: 5n } as const, party("p2", 5n, WSOL)];
    const a = await build(plan(shares, 2_000n, cycle, { ...SIMULATION_DISTRIBUTION_POLICY, missingPayoutWallet: "withhold" }));
    const b = await build(plan([...shares].reverse(), 2_000n, cycle, { ...SIMULATION_DISTRIBUTION_POLICY, missingPayoutWallet: "withhold" }));
    expect(a.leaves.map((l) => l.partyId)).toEqual(["p1", "p2"]);
    expect(b).toEqual(a);
  });

  it("refuses two parties sharing a payout wallet, zero payable amounts, empty trees and too many leaves", async () => {
    expect(await code(() => build(plan([party("a", 1n, "01".repeat(32)), party("b", 1n, "01".repeat(32))], 10n)))).toBe("duplicate_recipient");
    expect(await code(() => build(plan([party("a", 1n, "01".repeat(32)), party("z", 0n, "02".repeat(32))], 10n)))).toBe("amount_out_of_range");
    expect(await code(() => build(plan([party("a", 1n, null)], 10n)))).toBe("empty_tree");
    expect(await code(() => build(exampleF(), { policy: { ...SIMULATION_CLAIM_TREE_POLICY, maxLeaves: 2 } }))).toBe("too_many_leaves");
    expect(await code(() => build(exampleF(), { context: { ...context, clusterIdentity: "aa".repeat(31) } }))).toBe("invalid_key");
    expect(await code(() => build(exampleF(), { context: { ...context, extra: 1 } as never }))).toBe("invalid_parameter");
    expect(await code(() => build(plan([party("a", 1n, "01".repeat(32))], 10n, { ...cycle, id: "not-a-uuid" })))).toBe("invalid_input");
  });

  it("binds every leaf to its tree: changing any context field changes every leaf and the root", async () => {
    const t = await build();
    for (const patch of [{ networkId: 8 }, { clusterIdentity: "ab".repeat(32) }, { epoch: 1 }, { economicAssetId: "bc".repeat(32) }, { payoutMint: "11111111111111111111111111111111" }, { formulaVersion: 2 }]) {
      const u = await build(exampleF(), { context: { ...context, ...patch } });
      expect(u.root).not.toBe(t.root);
      u.leaves.forEach((l, i) => expect(l.leafHash).not.toBe(t.leaves[i]!.leafHash));
    }
    const v2 = await build(plan([party("c", 1n, "03".repeat(32)), party("a", 1n, "01".repeat(32)), party("b", 1n, "02".repeat(32))], 1_000_000n, { ...cycle, version: 2 }));
    expect(v2.root).not.toBe(t.root);
  });
});

describe("proofs", () => {
  it("reject a changed leaf, index, size, root, path or hasher", async () => {
    const t = await build();
    const l = t.leaves[1]!;
    const bytes = unhex(l.leafBytes);
    const tampered = new Uint8Array(bytes);
    tampered[185] = tampered[185]! ^ 1; // amount
    const flipHex = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);
    const v = (b: Uint8Array, p = l.proof, hs: ClaimTreeHasher = SHA256_RFC9162_HASHER) => verifyClaimProof(hs, b, p);
    expect(await v(tampered)).toBe(false);
    expect(await v(bytes, { ...l.proof, leafIndex: 0 })).toBe(false);
    expect(await v(bytes, { ...l.proof, treeSize: 2 })).toBe(false);
    expect(await v(bytes, { ...l.proof, root: flipHex(l.proof.root) })).toBe(false);
    expect(await v(bytes, { ...l.proof, path: [flipHex(l.proof.path[0]!), ...l.proof.path.slice(1)] })).toBe(false);
    expect(await v(bytes, { ...l.proof, path: [...l.proof.path, l.proof.path[0]!] })).toBe(false);
    expect(await v(bytes, { ...l.proof, path: l.proof.path.slice(1) })).toBe(false);
    expect(await v(bytes, { ...l.proof, leafIndex: -1 })).toBe(false);
    expect(await v(bytes, { ...l.proof, path: ["zz"] })).toBe(false);
    expect(await v(bytes, l.proof, { id: "other", leaf: SHA256_RFC9162_HASHER.leaf, node: async (a, b) => SHA256_RFC9162_HASHER.node(b, a) })).toBe(false);
  });

  it("bind the tree size and leaf index only when checked against the published tree (verifyClaimLeafProof)", async () => {
    const t = await build();
    const l = t.leaves[1]!;
    const bytes = unhex(l.leafBytes);
    const trusted = { root: t.root, treeSize: t.size };
    // RFC 9162 property: in a 3-leaf tree, leaf 1's path also verifies if the proof claims 4 leaves.
    expect(await verifyClaimProof(SHA256_RFC9162_HASHER, bytes, { ...l.proof, treeSize: 4 })).toBe(true);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes, { ...l.proof, treeSize: 4 }, trusted)).toBe(false);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes, l.proof, trusted)).toBe(true);
    // The leaf bytes carry their index: leaf 1's bytes cannot be presented as leaf 0 or 2.
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes, t.leaves[0]!.proof, trusted)).toBe(false);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes, { ...l.proof, root: t.leaves[0]!.leafHash }, trusted)).toBe(false);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes.slice(1), l.proof, trusted)).toBe(false);
    for (const leaf of t.leaves) expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(leaf.leafBytes), leaf.proof, trusted)).toBe(true);
  });

  it("agree with the stack's RFC 9162 implementation (twin/commitments) for every size from 1 to 40", async () => {
    // With the SHA-256 hasher, leaf(b) = SHA-256(0x00 ‖ SHA-256(b)) = merkleLeaf(SHA-256(b)).
    for (let n = 1; n <= 40; n++) {
      const leaves = Array.from({ length: n }, (_, i) => new TextEncoder().encode(`leaf-${n}-${i}`));
      const ours = await merkleTreeOverLeafBytes(SHA256_RFC9162_HASHER, leaves);
      const theirLeaves = await Promise.all(leaves.map(async (b) => merkleLeaf(await sha(b))));
      expect(ours.leafHashes).toEqual(theirLeaves);
      expect(ours.root).toBe(await merkleRoot(theirLeaves));
      for (const i of new Set([0, Math.floor(n / 2), n - 1])) {
        expect(ours.proofs[i]!.path).toEqual(await merkleAuditPath(theirLeaves, i));
        expect(await verifyMerkleInclusion({ leaf: theirLeaves[i]!, index: i, size: n, path: ours.proofs[i]!.path, root: ours.root })).toBe(true);
        expect(await verifyClaimProof(SHA256_RFC9162_HASHER, leaves[i]!, ours.proofs[i]!)).toBe(true);
      }
    }
  }, 60_000);
});

describe("pluggable hashing and fail-closed policy (D-26)", () => {
  // A different construction (SHA-384 truncated, its own prefixes): stands in for whatever D-26 chooses.
  const truncated: ClaimTreeHasher = {
    id: "test-sha384-truncated",
    leaf: async (b) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-384", new Uint8Array([0x10, ...b]))).slice(0, 32),
    node: async (l, r) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-384", new Uint8Array([0x11, ...l, ...r]))).slice(0, 32),
  };

  it("swaps the hasher without touching leaves: same leaf bytes, different root, proofs verify only under their hasher", async () => {
    const a = await build();
    const b = await build(exampleF(), { hasher: truncated, policy: { ...SIMULATION_CLAIM_TREE_POLICY, hasherId: truncated.id } });
    expect(b.leaves.map((l) => l.leafBytes)).toEqual(a.leaves.map((l) => l.leafBytes));
    expect(b.root).not.toBe(a.root);
    for (const l of b.leaves) {
      expect(await verifyClaimProof(truncated, unhex(l.leafBytes), l.proof)).toBe(true);
      expect(await verifyClaimProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), l.proof)).toBe(false);
    }
  });

  it("refuses a hasher the policy does not name", async () => {
    expect(await code(() => build(exampleF(), { hasher: truncated }))).toBe("hasher_mismatch");
  });

  it("is simulation-only until D-26: real cycles need an approved claim-tree policy", async () => {
    const real = { ...cycle, simulation: false };
    const realPlan = plan([party("a", 1n, "01".repeat(32))], 10n, real, { ...SIMULATION_DISTRIBUTION_POLICY, status: "approved" });
    expect(await code(() => build(realPlan))).toBe("YieldRecordError");
    await expect(build(realPlan)).rejects.toBeInstanceOf(YieldRecordError);
    await expect(build(realPlan, { policy: { ...SIMULATION_CLAIM_TREE_POLICY, status: "approved" } })).resolves.toBeDefined();
    await expect(build(exampleF(), { policy: { ...SIMULATION_CLAIM_TREE_POLICY, status: "draft" } })).rejects.toBeInstanceOf(YieldRecordError);
  });

  it("validates the policy record", () => {
    expect(claimTreePolicyProblems(SIMULATION_CLAIM_TREE_POLICY)).toEqual([]);
    expect(claimTreePolicyProblems({})).toHaveLength(6);
    expect(claimTreePolicyProblems({ ...SIMULATION_CLAIM_TREE_POLICY, leafLayoutVersion: 2 })).toEqual([]); // layout 2: snapshot-bound
    expect(claimTreePolicyProblems({ ...SIMULATION_CLAIM_TREE_POLICY, leafLayoutVersion: 3 })).toHaveLength(1);
    expect(claimTreePolicyProblems({ ...SIMULATION_CLAIM_TREE_POLICY, maxLeaves: 2 ** 32 + 1 })).toHaveLength(1);
    expect(claimTreePolicyProblems({ ...SIMULATION_CLAIM_TREE_POLICY, hashFunction: "keccak" })).toHaveLength(1);
  });
});
