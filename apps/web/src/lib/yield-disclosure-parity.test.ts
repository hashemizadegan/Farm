/**
 * D-39 must read the same in every client: the web banner and the Unity starter's YieldDisclosure carry the same
 * text and version id. This compares the C# source with the web constants, so changing one without the other fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { D39_DISCLOSURE_ID, D39_SIMULATION_DISCLOSURE } from "./yield";

const cs = readFileSync(fileURLToPath(new URL("../../../../clients/unity-starter/Runtime/Core/Models/YieldDisclosure.cs", import.meta.url)), "utf8");
const constant = (name: string) => {
  const m = new RegExp(`const string ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)";`).exec(cs);
  if (!m) throw new Error(`YieldDisclosure.${name} not found`);
  return m[1];
};

describe("D-39 parity: web and Unity", () => {
  it("has the same banner text and version id", () => {
    expect(constant("SimulationBanner")).toBe(D39_SIMULATION_DISCLOSURE);
    expect(constant("Id")).toBe(D39_DISCLOSURE_ID);
    expect(constant("Language")).toBe("en");
  });
});
