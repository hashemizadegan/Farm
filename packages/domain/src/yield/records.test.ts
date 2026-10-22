import { describe, expect, it } from "vitest";
import { YIELD_RECORD_STATUSES, YieldRecordError, assertYieldRecordUsable, yieldRecordUsable } from "./records";

describe("record usability", () => {
  it("lets real cycles use approved records only, and simulation cycles simulation records only", () => {
    const table = YIELD_RECORD_STATUSES.map((s) => [s, yieldRecordUsable({ simulation: false }, s), yieldRecordUsable({ simulation: true }, s)]);
    expect(table).toEqual([
      ["draft", false, false],
      ["approved", true, false],
      ["simulation", false, true],
    ]);
  });

  it("refuses when the cycle kind is not stated, and explains a refusal", () => {
    expect(yieldRecordUsable({} as never, "approved")).toBe(false);
    expect(() => assertYieldRecordUsable({ simulation: false }, { status: "simulation", kind: "calculation policy" })).toThrow(YieldRecordError);
    expect(() => assertYieldRecordUsable({ simulation: false }, { status: "draft", kind: "calculation policy" })).toThrow(/real cycle cannot use a draft calculation policy/);
    expect(() => assertYieldRecordUsable({ simulation: true }, { status: "approved", kind: "quorum" })).toThrow(YieldRecordError);
    expect(() => assertYieldRecordUsable({ simulation: true }, { status: "simulation", kind: "quorum" })).not.toThrow();
  });
});
