/** The client starter's sample payloads must stay in the shape the API returns. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { checkStorageRef, merkleLeaf, verifyMerkleInclusion } from "./commitments";
import { twinAssetDetailSchema, twinLayerOf, twinSceneSchema } from "./model";
import { reconstructFarmSnapshot, serializeFarmSnapshot } from "./snapshot";
import { planAnchor } from "./anchor";

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

  it("snapshot-document.sample.json carries a snapshot that verifies", async () => {
    const doc = load("snapshot-document.sample.json") as { check: { ok: boolean }; snapshot: unknown };
    expect(doc.check.ok).toBe(true);
    const { check } = await reconstructFarmSnapshot(JSON.stringify(doc.snapshot));
    expect(check.ok).toBe(true);
  });

  it("the anchor-plan samples are exactly what planAnchor returns for their roots", async () => {
    const { snapshot } = await reconstructFarmSnapshot(readFileSync(path.join(samples, "farm-snapshot.sample.json"), "utf8"));
    const snap = load("snapshot-anchor-plan.sample.json") as { snapshotId: string; plan: unknown };
    expect(snap.snapshotId).toBe(snapshot.snapshotId);
    // The API labels a snapshot anchor `farm-` and the first 14 hex digits of the farm id (twin-anchors.ts).
    const label = `farm-${snapshot.farmId.replace(/-/g, "").slice(0, 14)}`;
    expect(snap.plan).toEqual(planAnchor({ carrier: "token2022_metadata", network: "solana-devnet", subject: "snapshot", root: snapshot.root, label, mainnetEnabled: false }));

    const proof = (load("commitment-proof.sample.json") as { proof: { root: string; dataset: string } }).proof;
    const batch = load("batch-anchor-plan.sample.json") as { plan: unknown };
    expect(batch.plan).toEqual(
      planAnchor({ carrier: "bubblegum_v1_leaf", network: "solana-devnet", subject: "batch", root: proof.root, label: proof.dataset, documentBaseUrl: "https://metadata.example.test", mainnetEnabled: false }),
    );
  });

  it("the snapshot chain samples link exact bytes -> commitment -> batch root -> anchor plan", async () => {
    const bytes = readFileSync(path.join(samples, "snapshot-content.sample.json"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    // The content sample is exactly the platform's serialisation of the snapshot sample, and verifies.
    const { snapshot, check } = await reconstructFarmSnapshot(readFileSync(path.join(samples, "farm-snapshot.sample.json"), "utf8"));
    expect(check.ok).toBe(true);
    expect(bytes.toString("utf8")).toBe(serializeFarmSnapshot(snapshot));

    const doc = load("snapshot-proof.sample.json") as {
      commitment: { schema: string; subjectId: string; contentSha256: string; byteSize: number; storageRef: string; batch: { id: string; leafIndex: number } };
      proof: { batchId: string; dataset: string; leaf: string; leafIndex: number; size: number; path: string[]; root: string };
    };
    expect(doc.commitment).toMatchObject({ schema: "metafarm.farm-snapshot", subjectId: snapshot.farmId, contentSha256: sha, byteSize: bytes.length, storageRef: `sha256:${sha}` });
    expect(checkStorageRef(doc.commitment.storageRef, sha)).toEqual({ kind: "hash" });
    expect(doc.proof.leaf).toBe(await merkleLeaf(sha));
    expect(doc.commitment.batch).toEqual({ id: doc.proof.batchId, leafIndex: doc.proof.leafIndex });
    expect(await verifyMerkleInclusion({ leaf: doc.proof.leaf, index: doc.proof.leafIndex, size: doc.proof.size, path: doc.proof.path, root: doc.proof.root })).toBe(true);

    const plan = load("snapshot-batch-anchor-plan.sample.json") as { batchId: string; plan: unknown };
    expect(plan.batchId).toBe(doc.proof.batchId);
    expect(plan.plan).toEqual(planAnchor({ carrier: "token2022_metadata", network: "solana-devnet", subject: "batch", root: doc.proof.root, label: doc.proof.dataset, mainnetEnabled: false }));
  });
});
