import { describe, expect, it } from "vitest";
import { rolesWith } from "./notifications";

describe("notification recipients", () => {
  it("follows permissions", () => {
    expect(rolesWith("inventory:manage")).toEqual(["owner", "admin", "manager"]);
    expect(rolesWith("alert:ack")).toEqual(["owner", "admin", "manager"]);
    expect(rolesWith("task:work")).toContain("worker");
  });
});
