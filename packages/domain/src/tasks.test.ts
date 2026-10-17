import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./roles";
import { addDays, createTaskSchema, dayInZone, isWorkerOnlyUpdate, nextOccurrence, updateTaskSchema } from "./tasks";

describe("nextOccurrence", () => {
  it("keeps the rhythm when completed on time or early", () => {
    expect(nextOccurrence("2026-10-17", 3, "2026-10-17")).toBe("2026-10-20");
    expect(nextOccurrence("2026-10-17", 3, "2026-10-15")).toBe("2026-10-20");
  });

  it("skips occurrences already missed instead of creating a backlog", () => {
    // Due the 1st every 3 days, done on the 9th: the 4th and 7th are past, next is the 10th.
    expect(nextOccurrence("2026-10-01", 3, "2026-10-09")).toBe("2026-10-10");
    // Done exactly on a missed occurrence day moves to the following one.
    expect(nextOccurrence("2026-10-01", 3, "2026-10-10")).toBe("2026-10-13");
  });

  it("crosses month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(nextOccurrence("2026-02-27", 7, "2026-02-27")).toBe("2026-03-06");
  });
});

describe("task schemas", () => {
  it("accepts a valid task and defaults priority", () => {
    const t = createTaskSchema.parse({ title: " Irrigate block A ", kind: "irrigation", dueDate: "2026-10-18", repeatEveryDays: 3 });
    expect(t.title).toBe("Irrigate block A");
    expect(t.priority).toBe("normal");
  });

  it("rejects impossible dates and unknown fields", () => {
    expect(createTaskSchema.safeParse({ title: "x", kind: "other", dueDate: "2026-02-30" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "x", kind: "other", dueDate: "2026-02-01", status: "done" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
  });

  it("lets workers only start or reopen their own tasks", () => {
    expect(isWorkerOnlyUpdate({ status: "in_progress" })).toBe(true);
    expect(isWorkerOnlyUpdate({ status: "cancelled" })).toBe(false);
    expect(isWorkerOnlyUpdate({ status: "todo", dueDate: "2026-10-20" })).toBe(false);
  });
});

describe("field worker role", () => {
  it("can do field work but not change the farm or the team", () => {
    const w = ROLE_PERMISSIONS.worker;
    expect([...w].sort()).toEqual(
      ["alert:read", "asset:read", "farm:read", "media:upload", "observation:read", "observation:write", "task:work"].sort(),
    );
    expect(ROLE_PERMISSIONS.manager.has("task:manage")).toBe(true);
    expect(ROLE_PERMISSIONS.viewer.has("task:work")).toBe(false);
  });
});

describe("dayInZone", () => {
  it("uses the farm's calendar day", () => {
    const late = new Date("2026-10-17T21:00:00Z"); // 00:30 on the 18th in Tehran
    expect(dayInZone(late, "Asia/Tehran")).toBe("2026-10-18");
    expect(dayInZone(late, "UTC")).toBe("2026-10-17");
  });
});
