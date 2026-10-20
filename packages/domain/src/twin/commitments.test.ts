import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_LEAVES,
  checkStorageRef,
  commitToRecord,
  contentHash,
  merkleAuditPath,
  merkleLeaf,
  merkleRoot,
  verifyMerkleInclusion,
} from "./commitments";

const sha = (parts: (Buffer | Uint8Array)[]) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");
const item = (i: number) => createHash("sha256").update(`item-${i}`).digest("hex");

/** RFC 9162 Merkle tree hash written out independently (Node crypto, synchronous). */
function referenceRoot(contentHashes: string[]): string {
  const leaf = (h: string) => Buffer.from(sha([Uint8Array.of(0), Buffer.from(h, "hex")]), "hex");
  const mth = (xs: Buffer[]): Buffer => {
    if (xs.length === 1) return xs[0]!;
    let k = 1;
    while (k * 2 < xs.length) k *= 2;
    return Buffer.from(sha([Uint8Array.of(1), mth(xs.slice(0, k)), mth(xs.slice(k))]), "hex");
  };
  return mth(contentHashes.map(leaf)).toString("hex");
}

describe("content hashes and record commitments", () => {
  it("hashes bytes and strings with SHA-256", async () => {
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await contentHash(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("commits to schema, version and record, independent of key order", async () => {
    const a = await commitToRecord("metafarm.harvest-lot", 1, { kg: 120, crop: "pistachio" });
    const b = await commitToRecord("metafarm.harvest-lot", 1, { crop: "pistachio", kg: 120 });
    expect(a).toEqual(b);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await commitToRecord("metafarm.harvest-lot", 2, { kg: 120, crop: "pistachio" })).sha256).not.toBe(a.sha256);
    expect((await commitToRecord("metafarm.storage-lot", 1, { kg: 120, crop: "pistachio" })).sha256).not.toBe(a.sha256);
  });

  it("refuses malformed schema names and versions", async () => {
    await expect(commitToRecord("Bad Schema", 1, {})).rejects.toThrow(RangeError);
    await expect(commitToRecord("ok", 0, {})).rejects.toThrow(RangeError);
    await expect(commitToRecord("ok", 1.5, {})).rejects.toThrow(RangeError);
  });
});

describe("Merkle batches (RFC 9162)", () => {
  it("matches an independent implementation for every size up to 33", async () => {
    for (let n = 1; n <= 33; n++) {
      const items = Array.from({ length: n }, (_, i) => item(i));
      const leaves = await Promise.all(items.map(merkleLeaf));
      expect(await merkleRoot(leaves)).toBe(referenceRoot(items));
    }
  });

  it("proves and verifies every leaf of every size up to 17", async () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = await Promise.all(Array.from({ length: n }, (_, i) => merkleLeaf(item(i))));
      const root = await merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const path = await merkleAuditPath(leaves, i);
        expect(await verifyMerkleInclusion({ leaf: leaves[i]!, index: i, size: n, path, root })).toBe(true);
      }
    }
  });

  it("rejects a proof for another leaf, index, size, root or a changed path", async () => {
    const leaves = await Promise.all(Array.from({ length: 11 }, (_, i) => merkleLeaf(item(i))));
    const root = await merkleRoot(leaves);
    const path = await merkleAuditPath(leaves, 6);
    const ok = { leaf: leaves[6]!, index: 6, size: 11, path, root };
    expect(await verifyMerkleInclusion(ok)).toBe(true);
    expect(await verifyMerkleInclusion({ ...ok, leaf: leaves[5]! })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, index: 7 })).toBe(false);
    // A wrong size is caught when it changes the tree's shape; the root binds the real size anyway,
    // and the platform stores each batch's size with its root.
    expect(await verifyMerkleInclusion({ ...ok, size: 7 })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, size: 5 })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, root: leaves[0]! })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, path: [...path.slice(0, -1), leaves[0]!] })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, path: path.slice(1) })).toBe(false);
    expect(await verifyMerkleInclusion({ ...ok, path: [...path, leaves[0]!] })).toBe(false);
  });

  it("never confuses a leaf with an interior node", async () => {
    const leaves = await Promise.all([0, 1].map((i) => merkleLeaf(item(i))));
    const root = await merkleRoot(leaves);
    // A one-leaf "batch" whose leaf is the two-leaf root is a different tree: the 0x00/0x01 prefixes differ.
    expect(await merkleRoot([root])).toBe(root);
    expect(root).not.toBe(await merkleLeaf(root));
  });

  it("answers false, not an exception, for malformed proofs", async () => {
    const leaf = await merkleLeaf(item(0));
    expect(await verifyMerkleInclusion({ leaf: "zz", index: 0, size: 1, path: [], root: leaf })).toBe(false);
    expect(await verifyMerkleInclusion({ leaf, index: -1, size: 1, path: [], root: leaf })).toBe(false);
    expect(await verifyMerkleInclusion({ leaf, index: 0, size: 0, path: [], root: leaf })).toBe(false);
    expect(await verifyMerkleInclusion({ leaf, index: 0, size: 1, path: ["nothex"], root: leaf })).toBe(false);
  });

  it("refuses empty, oversized and malformed batches", async () => {
    await expect(merkleRoot([])).rejects.toThrow(RangeError);
    await expect(merkleRoot(["ABC"])).rejects.toThrow(RangeError);
    await expect(merkleRoot(Array.from({ length: MAX_BATCH_LEAVES + 1 }, () => item(0)))).rejects.toThrow(RangeError);
    await expect(merkleAuditPath([item(0)], 1)).rejects.toThrow(RangeError);
  });
});

describe("storage references", () => {
  const h = item(1);
  it("accepts only content-addressed references", () => {
    expect(checkStorageRef(`sha256:${h}`, h)).toEqual({ kind: "hash" });
    expect(checkStorageRef(`s3://farm-media/tenants/t1/${h}`, h)).toEqual({ kind: "object_storage" });
    expect(checkStorageRef(`s3://farm-media/${h}.jpg`, h)).toEqual({ kind: "object_storage" });
    expect(checkStorageRef("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", h)).toEqual({ kind: "ipfs" });
    expect(checkStorageRef(`ar://${"a".repeat(43)}`, h)).toEqual({ kind: "arweave" });
  });

  it("refuses references that are not tied to the content", () => {
    expect(checkStorageRef(`sha256:${item(2)}`, h)).toHaveProperty("error");
    expect(checkStorageRef("s3://farm-media/photo.jpg", h)).toHaveProperty("error");
    expect(checkStorageRef(`s3://farm-media/${item(2)}`, h)).toHaveProperty("error");
    expect(checkStorageRef(`https://example.com/${h}`, h)).toHaveProperty("error");
  });
});
