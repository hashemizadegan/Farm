/** The client starter's sample payloads must stay in the shape the API returns. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStorageRef, merkleLeaf, verifyMerkleInclusion } from "./commitments";
import { twinAssetDetailSchema, twinLayerOf, twinSceneSchema } from "./model";
import { reconstructFarmSnapshot } from "./snapshot";

const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples");
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(samples, name), "utf8"));

describe("client starter samples", () => {
  it("scene.sample.json is a valid scene, each object on its kind's layer", () => {
    const scene = twinSceneSchema.parse(load("scene.sample.json"));
    for (const o of scene.objects) expect(o.layer).toBe(twinLayerOf(o.kind));
  });

  it("asset-detail.sample.json is a valid asset detail with content-addressed references", () => {
    const detail = twinAssetDetailSchema.parse(load("asset-detail.sample.json"));
    for (const c of detail.dataCommitments) if (c.storageRef) expect(checkStorageRef(c.storageRef, c.contentSha256)).toEqual({ kind: "hash" });
  });

  it("commitment-proof.sample.json is a proof the platform's own verifier accepts (the C# tests use the same vectors)", async () => {
    const sample = load("commitment-proof.sample.json") as {
      commitment: { contentSha256: string; batch: { leafIndex: number } };
      proof: { leaf: string; leafIndex: number; size: number; path: string[]; root: string };
    };
    expect(await merkleLeaf(sample.commitment.contentSha256)).toBe(sample.proof.leaf);
    expect(sample.commitment.batch.leafIndex).toBe(sample.proof.leafIndex);
    expect(await verifyMerkleInclusion({ leaf: sample.proof.leaf, index: sample.proof.leafIndex, size: sample.proof.size, path: sample.proof.path, root: sample.proof.root })).toBe(true);
  });

  it("farm-snapshot.sample.json reconstructs and verifies with the platform's snapshot verifier (the C# tests use it too)", async () => {
    const { snapshot, check } = await reconstructFarmSnapshot(readFileSync(path.join(samples, "farm-snapshot.sample.json"), "utf8"));
    expect(check).toEqual({ ok: true, problems: [] });
    expect(snapshot.entityCount).toBe(7);
  });
});
