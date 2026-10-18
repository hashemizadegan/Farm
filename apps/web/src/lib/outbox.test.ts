import { describe, expect, it } from "vitest";
import { outcomeOf } from "./outbox-outcome";

describe("outbox outcomes", () => {
  it("removes sent entries", () => {
    expect(outcomeOf(200)).toBe("sent");
    expect(outcomeOf(201)).toBe("sent");
    expect(outcomeOf(202)).toBe("sent");
  });
  it("retries when the problem is the connection, the sign-in or the server", () => {
    for (const s of ["network", 401, 408, 429, 500, 502, 503] as const) expect(outcomeOf(s)).toBe("retry-later");
  });
  it("asks the person when the server refuses the record", () => {
    for (const s of [400, 403, 404, 409, 422]) expect(outcomeOf(s)).toBe("failed");
  });
});
