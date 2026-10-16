import { describe, expect, it } from "vitest";
import { buildSchedules } from "./schedules";

describe("buildSchedules", () => {
  it("always schedules the alert sweep", () => {
    const s = buildSchedules({ alertCron: "*/5 * * * *", chainCron: "* * * * *", chainId: 1, contracts: [] });
    expect(s.map((x) => x.id)).toEqual(["alerts-sweep"]);
  });

  it("adds one stable chain schedule per contract", () => {
    const cfg = {
      alertCron: "*/5 * * * *",
      chainCron: "* * * * *",
      chainId: 1,
      contracts: [{ address: "0xABCDEF0000000000000000000000000000000001", fromBlock: "100" }],
    };
    const a = buildSchedules(cfg);
    const b = buildSchedules(cfg);
    expect(a).toEqual(b);
    expect(a[1]!.id).toBe("chain-index-1-0xabcdef0000000000000000000000000000000001");
  });
});
