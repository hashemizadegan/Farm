import { describe, expect, it } from "vitest";
import { ProvenanceError, assertValidProvenance, boundaryProvenanceLabel } from "./provenance";

const evidence = {
  id: "e1",
  kind: "survey-document" as const,
  mediaObjectId: "m1",
  reviewerUserId: "u1",
  reviewedAt: "2026-01-01T00:00:00Z",
};

describe("provenance", () => {
  it("refuses independently-verified without evidence", () => {
    expect(() =>
      assertValidProvenance({ label: "independently-verified", sourceTimestamp: "2026-01-01T00:00:00Z", source: "x" }),
    ).toThrow(ProvenanceError);
  });

  it("accepts independently-verified with complete evidence", () => {
    expect(
      assertValidProvenance({
        label: "independently-verified",
        sourceTimestamp: "2026-01-01T00:00:00Z",
        source: "x",
        evidence: [evidence],
      }).label,
    ).toBe("independently-verified");
  });

  it("rejects evidence missing a reviewer", () => {
    expect(() =>
      assertValidProvenance({
        label: "independently-verified",
        sourceTimestamp: "2026-01-01T00:00:00Z",
        source: "x",
        evidence: [{ ...evidence, reviewerUserId: "" }],
      }),
    ).toThrow(ProvenanceError);
  });

  it("labels boundaries user-entered until evidence exists", () => {
    expect(boundaryProvenanceLabel(undefined)).toBe("user-entered");
    expect(boundaryProvenanceLabel([])).toBe("user-entered");
    expect(boundaryProvenanceLabel([evidence])).toBe("independently-verified");
  });

  it("rejects unknown labels and bad timestamps", () => {
    expect(() =>
      assertValidProvenance({ label: "verified" as never, sourceTimestamp: "2026-01-01T00:00:00Z", source: "x" }),
    ).toThrow(ProvenanceError);
    expect(() => assertValidProvenance({ label: "user-entered", sourceTimestamp: "yesterday", source: "x" })).toThrow(
      ProvenanceError,
    );
  });
});
