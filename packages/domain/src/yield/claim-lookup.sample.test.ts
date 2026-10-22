/**
 * The C# client verifies clients/unity-starter/Samples/claim-payloads.sample.json, which holds claim
 * payloads served from the live artifact of the PR #73 pipeline scenario. This test reruns the pipeline,
 * rebuilds the file and requires the committed copy to match exactly, and verifies every claim in it.
 *
 * To regenerate after a deliberate change: write `await claimPayloadSampleText()` to that file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHA256_RFC9162_HASHER } from "./claim-tree";
import { type ClaimPayloadDto, type PublishedClaimTree, verifyClaimPayload } from "./claim-lookup";
import { claimPayloadSampleText } from "./claim-lookup.sample.test-support";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples/claim-payloads.sample.json");

describe("claim payload sample shared with C#", () => {
  it("the committed file is exactly what the live pipeline and lookup produce", async () => {
    expect(readFileSync(file, "utf8")).toBe(await claimPayloadSampleText());
  });

  it("every claim in it verifies against its published tree", async () => {
    const s = JSON.parse(readFileSync(file, "utf8")) as { publishedTree: PublishedClaimTree; claims: ClaimPayloadDto[] };
    expect(s.claims.length).toBe(2);
    for (const c of s.claims) expect(await verifyClaimPayload(c, s.publishedTree, SHA256_RFC9162_HASHER)).toBe(true);
  });
});
