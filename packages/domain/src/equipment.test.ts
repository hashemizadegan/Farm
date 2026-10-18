import { describe, expect, it } from "vitest";
import { maintenanceDue, maintenancePlanSchema, serviceRecordSchema } from "./equipment";

describe("maintenance due", () => {
  const plan = { everyHours: 250, everyDays: 180, lastDoneOn: "2026-05-01", lastDoneHours: 1000 };

  it("is due by hours or days, whichever comes first", () => {
    expect(maintenanceDue(plan, { today: "2026-06-01", hours: 1100 })).toEqual({ state: "ok", dueOn: "2026-10-28", dueHours: 1250 });
    expect(maintenanceDue(plan, { today: "2026-06-01", hours: 1230 }).state).toBe("soon");
    expect(maintenanceDue(plan, { today: "2026-06-01", hours: 1250 }).state).toBe("overdue");
    expect(maintenanceDue(plan, { today: "2026-10-22", hours: 1100 }).state).toBe("soon");
    expect(maintenanceDue(plan, { today: "2026-10-28", hours: 1100 }).state).toBe("overdue");
  });

  it("works with only a calendar interval, or without readings", () => {
    expect(maintenanceDue({ everyHours: null, everyDays: 30, lastDoneOn: "2026-10-01", lastDoneHours: null }, { today: "2026-10-18", hours: null })).toEqual({
      state: "ok",
      dueOn: "2026-10-31",
      dueHours: null,
    });
    expect(maintenanceDue({ everyHours: 100, everyDays: null, lastDoneOn: "2026-10-01", lastDoneHours: 10 }, { today: "2026-10-18", hours: null }).state).toBe("ok");
  });
});

describe("maintenance inputs", () => {
  it("needs an interval and, for hours, the meter at the last service", () => {
    expect(maintenancePlanSchema.safeParse({ title: "Oil", lastDoneOn: "2026-10-01" }).success).toBe(false);
    expect(maintenancePlanSchema.safeParse({ title: "Oil", everyHours: 250, lastDoneOn: "2026-10-01" }).success).toBe(false);
    expect(maintenancePlanSchema.safeParse({ title: "Oil", everyHours: 250, lastDoneOn: "2026-10-01", lastDoneHours: "1000" }).success).toBe(true);
    expect(serviceRecordSchema.safeParse({ doneOn: "2026-10-01", description: "Oil change", cost: "10" }).success).toBe(false);
  });
});
