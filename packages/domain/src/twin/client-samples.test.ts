/** The client starter's sample payloads must stay in the shape the API returns. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStorageRef } from "./commitments";
import { twinAssetDetailSchema, twinLayerOf, twinSceneSchema } from "./model";

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
});
