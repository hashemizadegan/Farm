import { describe, expect, it } from "vitest";
import { ASSET_KINDS } from "../rwa/model";
import { TWIN_LAYERS, createDataCommitmentSchema, transferPreviewSchema, twinLayerOf, twinObjectId, verificationStateOf } from "./model";

const HASH = "a".repeat(64);

describe("twin model", () => {
  it("puts every asset kind on a scene layer, and none on terrain", () => {
    for (const k of ASSET_KINDS) {
      expect(TWIN_LAYERS).toContain(twinLayerOf(k));
      expect(twinLayerOf(k)).not.toBe("terrain");
    }
    expect(twinLayerOf("parcel")).toBe("plots");
    expect(twinLayerOf("storage_unit")).toBe("storage");
  });

  it("derives twin ids from asset ids", () => {
    expect(twinObjectId("4f1c1c1e-0000-4000-8000-000000000001")).toBe("asset:4f1c1c1e-0000-4000-8000-000000000001");
  });

  it("claims anchoring only when the inclusion proof and the chain both check out", () => {
    expect(verificationStateOf({ inclusionVerified: false, anchorConfirmedOnChain: false })).toBe("recorded");
    expect(verificationStateOf({ inclusionVerified: false, anchorConfirmedOnChain: true })).toBe("recorded");
    expect(verificationStateOf({ inclusionVerified: true, anchorConfirmedOnChain: false })).toBe("included");
    expect(verificationStateOf({ inclusionVerified: true, anchorConfirmedOnChain: true })).toBe("anchored");
  });

  it("validates data commitments", () => {
    const ok = { subjectType: "telemetry_window", subjectId: "sensor-7/2026-10-20T10", schema: "metafarm.telemetry-hour", schemaVersion: 1, contentSha256: HASH, sourceTime: "2026-10-20T10:00:00Z" };
    expect(createDataCommitmentSchema.safeParse(ok).success).toBe(true);
    expect(createDataCommitmentSchema.safeParse({ ...ok, contentSha256: HASH.toUpperCase() }).success).toBe(false);
    expect(createDataCommitmentSchema.safeParse({ ...ok, subjectType: "wallet" }).success).toBe(false);
    expect(createDataCommitmentSchema.safeParse({ ...ok, verified: true }).success).toBe(false);
    expect(createDataCommitmentSchema.safeParse({ ...ok, sourceTime: "yesterday" }).success).toBe(false);
  });

  it("validates transfer preview requests", () => {
    const ok = { representationId: "4f1c1c1e-0000-4000-8000-000000000001", from: "A".repeat(44), to: "B".repeat(44), amount: "1" };
    expect(transferPreviewSchema.safeParse(ok).success).toBe(true);
    expect(transferPreviewSchema.safeParse({ ...ok, amount: "0" }).success).toBe(false);
    expect(transferPreviewSchema.safeParse({ ...ok, amount: "-1" }).success).toBe(false);
    expect(transferPreviewSchema.safeParse({ ...ok, from: "0xdeadbeef" }).success).toBe(false);
    expect(transferPreviewSchema.safeParse({ ...ok, signedTransaction: "AAAA" }).success).toBe(false);
  });
});
