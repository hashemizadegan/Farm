/**
 * Builds the claim-tree parity vectors shared with the C# client core
 * (`clients/unity-starter/Samples/claim-tree-vectors.json`). Every value comes from this repository's
 * TypeScript implementation (`claim-tree.ts`, `distribution.ts`). Simulation records only.
 *
 * `claim-tree.vectors.test.ts` rebuilds the vectors and requires the committed file to match exactly, so a
 * change on either side fails CI until the vectors are regenerated deliberately.
 */
import { SHA256_RFC9162_HASHER, SIMULATION_CLAIM_TREE_POLICY, buildClaimTree, claimLeafDomainTag, decodeClaimLeaf, encodeClaimLeaf, type ClaimLeafContext } from "./claim-tree";
import { SIMULATION_DISTRIBUTION_POLICY, emptyDistributionLedger, planDistribution, type DistributionShare } from "./distribution";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
const uuidOf = (b: Uint8Array) => {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const VECTOR_CONTEXT: ClaimLeafContext = {
  networkId: 7,
  clusterIdentity: "aa".repeat(32),
  epoch: 0,
  economicAssetId: "bb".repeat(32),
  payoutMint: "So11111111111111111111111111111111111111112",
  formulaVersion: 1,
};
const CYCLE_ID = "00000000-0000-4000-8000-00000000000a";

/** Trees of 1, 3, 5, 7 and 8 leaves: every RFC 9162 shape up to a full power of two. */
const TREES: { name: string; version: number; ndy: bigint; weights: bigint[] }[] = [
  { name: "size-1", version: 1, ndy: 1_000n, weights: [1n] },
  { name: "size-3-example-f", version: 2, ndy: 1_000_000n, weights: [1n, 1n, 1n] },
  { name: "size-5", version: 3, ndy: 1_000_003n, weights: [1n, 2n, 3n, 4n, 5n] },
  { name: "size-7", version: 4, ndy: 9_999_999_999n, weights: [7n, 1n, 5n, 3n, 2n, 6n, 4n] },
  { name: "size-8", version: 5, ndy: 18_446_744_073_709_551_615n, weights: [1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n] },
];

export interface VectorLeaf {
  index: number;
  fields: {
    networkId: number;
    clusterIdentity: string;
    cycleId: string;
    cycleVersion: number;
    epoch: number;
    economicAssetId: string;
    recipient: string;
    payoutMint: string;
    amount: string;
    formulaVersion: number;
    leafLayoutVersion: number;
    leafIndex: number;
  };
  leafBytes: string;
  leafHash: string;
  path: string[];
}

export interface ClaimTreeVectors {
  description: string;
  hasherId: string;
  leafDomainTag: string;
  trees: { name: string; size: number; root: string; leaves: VectorLeaf[] }[];
  edgeLeaf: { fields: VectorLeaf["fields"]; leafBytes: string; leafHash: string };
}

async function fieldsOf(leafBytesHex: string): Promise<VectorLeaf["fields"]> {
  const f = await decodeClaimLeaf(unhex(leafBytesHex));
  return {
    networkId: f.networkId,
    clusterIdentity: hex(f.clusterIdentity),
    cycleId: uuidOf(f.cycleId),
    cycleVersion: f.cycleVersion,
    epoch: f.epoch,
    economicAssetId: hex(f.economicAssetId),
    recipient: hex(f.recipient),
    payoutMint: hex(f.payoutMint),
    amount: f.amount.toString(),
    formulaVersion: f.formulaVersion,
    leafLayoutVersion: f.leafLayoutVersion,
    leafIndex: f.leafIndex,
  };
}

export async function buildClaimTreeVectors(): Promise<ClaimTreeVectors> {
  const trees: ClaimTreeVectors["trees"] = [];
  for (const t of TREES) {
    // Wallets 0x10.., 0x11.., …, given in reverse so the tree's recipient ordering is exercised.
    const shares: DistributionShare[] = t.weights.map((weight, i) => ({ kind: "party", partyId: `party-${i}`, payoutWallet: (16 + t.weights.length - 1 - i).toString(16).repeat(32), weight }));
    const plan = planDistribution({ cycle: { id: CYCLE_ID, version: t.version, simulation: true }, policy: SIMULATION_DISTRIBUTION_POLICY, netDistributableYield: t.ndy, shares, ledger: emptyDistributionLedger() });
    const tree = await buildClaimTree({ plan, policy: SIMULATION_CLAIM_TREE_POLICY, hasher: SHA256_RFC9162_HASHER, context: VECTOR_CONTEXT });
    const leaves: VectorLeaf[] = [];
    for (const l of tree.leaves) leaves.push({ index: l.leafIndex, fields: await fieldsOf(l.leafBytes), leafBytes: l.leafBytes, leafHash: l.leafHash, path: l.proof.path });
    trees.push({ name: t.name, size: tree.size, root: tree.root, leaves });
  }

  // Every integer field at its maximum, and distinct byte patterns, to pin the little-endian layout.
  const edge = await encodeClaimLeaf({
    networkId: 255,
    clusterIdentity: Uint8Array.from({ length: 32 }, (_, i) => i),
    cycleId: unhex("ffffffffffff4fffbfffffffffffffff"),
    cycleVersion: 2 ** 32 - 1,
    epoch: 2 ** 32 - 2,
    economicAssetId: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
    recipient: Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 255),
    payoutMint: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 1) & 255),
    amount: 18_446_744_073_709_551_615n,
    formulaVersion: 65_535,
    leafLayoutVersion: 1,
    leafIndex: 2 ** 32 - 1,
  });
  const edgeHex = hex(edge);

  return {
    description:
      "Claim-tree parity vectors (plan rev. 4 section 6.2), generated from packages/domain/src/yield/claim-tree.ts by claim-tree.vectors.test-support.ts. Simulation only. Hasher sha256-rfc9162-double-leaf/1: leaf = SHA-256(0x00 || SHA-256(leafBytes)), node = SHA-256(0x01 || left || right). Amounts are decimal strings (u64).",
    hasherId: SHA256_RFC9162_HASHER.id,
    leafDomainTag: hex(await claimLeafDomainTag()),
    trees,
    edgeLeaf: { fields: await fieldsOf(edgeHex), leafBytes: edgeHex, leafHash: hex(await SHA256_RFC9162_HASHER.leaf(edge)) },
  };
}

/** The file's exact text: two-space JSON with a trailing newline. */
export async function claimTreeVectorsText(): Promise<string> {
  return `${JSON.stringify(await buildClaimTreeVectors(), null, 2)}\n`;
}
