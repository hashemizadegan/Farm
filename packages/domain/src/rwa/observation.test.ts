import { describe, expect, it } from "vitest";
import { canTransition, type OperationState } from "./lifecycle";
import { stepsAfterObservation } from "./observation";
import type { ObservedStatus } from "./ports";

const STATUSES: ObservedStatus[] = ["not_found", "pending", "observed", "final", "failed", "expired"];

describe("observations to lifecycle steps", () => {
  it("moves a submitted transaction forward by what the chain says", () => {
    expect(stepsAfterObservation("submitted", { status: "pending" })).toEqual([]);
    expect(stepsAfterObservation("submitted", { status: "observed" })).toEqual(["observed"]);
    expect(stepsAfterObservation("submitted", { status: "final" })).toEqual(["observed", "confirmed"]);
    expect(stepsAfterObservation("observed", { status: "final" })).toEqual(["confirmed"]);
    expect(stepsAfterObservation("observed", { status: "expired" })).toEqual(["expired"]);
    expect(stepsAfterObservation("submitted", { status: "failed", error: "custom program error" })).toEqual(["failed"]);
  });

  it("recovers a send that was never recorded", () => {
    expect(stepsAfterObservation("prepared", { status: "final" })).toEqual(["submitted", "observed", "confirmed"]);
    expect(stepsAfterObservation("prepared", { status: "not_found" })).toEqual([]);
    expect(stepsAfterObservation("prepared", { status: "expired" })).toEqual(["expired"]);
  });

  it("only ever produces allowed transitions", () => {
    for (const start of ["prepared", "submitted", "observed", "confirmed", "expired"] as OperationState[]) {
      for (const status of STATUSES) {
        let at = start;
        for (const next of stepsAfterObservation(start, { status })) {
          expect(canTransition(at, next)).toBe(true);
          at = next;
        }
      }
    }
  });
});
