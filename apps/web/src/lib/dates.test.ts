import { describe, expect, it } from "vitest";
import { localToday, shiftDay, weekStart } from "./dates";

describe("calendar days", () => {
  it("starts weeks on Monday or Saturday", () => {
    // 2026-10-17 is a Saturday.
    expect(weekStart("2026-10-17", 1)).toBe("2026-10-12");
    expect(weekStart("2026-10-17", 6)).toBe("2026-10-17");
    expect(weekStart("2026-10-16", 6)).toBe("2026-10-10");
  });

  it("shifts across months", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formats the device's local day", () => {
    expect(localToday(new Date(2026, 9, 7, 23, 59))).toBe("2026-10-07");
  });
});
