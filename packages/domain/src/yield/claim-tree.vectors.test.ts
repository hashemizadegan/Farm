/**
 * The C# client core checks its claim-leaf encoding and proof verification against
 * clients/unity-starter/Samples/claim-tree-vectors.json. This test rebuilds those vectors from the
 * TypeScript implementation and requires the committed file to match byte for byte, so the two sides
 * cannot drift apart silently.
 *
 * To regenerate after a deliberate change: write `await claimTreeVectorsText()` to that file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHA256_RFC9162_HASHER, verifyClaimLeafProof } from "./claim-tree";
import { type ClaimTreeVectors, claimTreeVectorsText } from "./claim-tree.vectors.test-support";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples/claim-tree-vectors.json");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

describe("claim-tree parity vectors shared with C#", () => {
  it("the committed file is exactly what the TypeScript implementation produces", async () => {
    expect(readFileSync(file, "utf8")).toBe(await claimTreeVectorsText());
  });

  it("every vector leaf verifies against its tree's published root and size", async () => {
    const v = JSON.parse(readFileSync(file, "utf8")) as ClaimTreeVectors;
    expect(v.trees.map((t) => t.size)).toEqual([1, 3, 5, 7, 8]);
    for (const t of v.trees)
      for (const l of t.leaves)
        expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), { leafIndex: l.index, treeSize: t.size, leafHash: l.leafHash, path: l.path, root: t.root }, { root: t.root, treeSize: t.size })).toBe(true);
  });
});
