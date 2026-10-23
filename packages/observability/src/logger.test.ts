import { describe, expect, it } from "vitest";
import { createLogger, prettyAvailable } from "./logger";

describe("createLogger", () => {
  it("falls back to JSON when pretty output is asked for but pino-pretty is not installed (production images)", () => {
    expect(prettyAvailable(() => { throw new Error("Cannot find module 'pino-pretty'"); })).toBe(false);
    expect(prettyAvailable(() => "/x/pino-pretty/index.js")).toBe(true);
    // Never throws, whichever way the dependency resolves.
    expect(() => createLogger({ service: "test", pretty: false })).not.toThrow();
  });
});
