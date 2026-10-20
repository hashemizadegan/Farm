import { describe, expect, it } from "vitest";
import { CNFT_METADATA_LIMITS } from "../rwa/cnft";
import { planAnchor } from "./anchor";

const ROOT = "5610b47577351888d614cb915e3b0d11fbc5d440a689446c1bd8e87d75194da5";
const base = { network: "solana-devnet" as const, root: ROOT, mainnetEnabled: false };

describe("anchor plans (reserved formats, never executed)", () => {
  it("describes a Token-2022 metadata field for a batch root", () => {
    const p = planAnchor({ ...base, carrier: "token2022_metadata", subject: "batch", label: "telemetry/2026-10-20" });
    expect(p).toMatchObject({ scheme: "metafarm-anchor/1", executable: false, reason: "anchoring_not_enabled" });
    expect(p.metadataField).toEqual({ key: "mf:batch:telemetry/2026-10-20", value: `metafarm-merkle-sha256/1:${ROOT}` });
    expect(p.leafMetadata).toBeUndefined();
  });

  it("describes Bubblegum V1 leaf metadata within the program's limits for a snapshot root", () => {
    const p = planAnchor({ ...base, carrier: "bubblegum_v1_leaf", subject: "snapshot", label: "farm-1", documentBaseUrl: "https://api.example.org/" });
    expect(p.leafMetadata).toEqual({ name: `MF snapshot ${ROOT.slice(0, 12)}`, symbol: "MFANCHOR", uri: `https://api.example.org/v1/public/anchors/${ROOT}` });
    expect(new TextEncoder().encode(p.leafMetadata!.name).length).toBeLessThanOrEqual(CNFT_METADATA_LIMITS.name);
    expect(p.executable).toBe(false);
  });

  it("refuses mainnet unless enabled, other chains, bad roots, labels and URLs", () => {
    expect(() => planAnchor({ ...base, network: "solana-mainnet", carrier: "token2022_metadata", subject: "batch", label: "x" })).toThrow(/not enabled/);
    expect(() => planAnchor({ ...base, network: "tron-nile", carrier: "token2022_metadata", subject: "batch", label: "x" })).toThrow(/Solana only/);
    expect(() => planAnchor({ ...base, root: "ABC", carrier: "token2022_metadata", subject: "batch", label: "x" })).toThrow(/root/);
    expect(() => planAnchor({ ...base, carrier: "token2022_metadata", subject: "batch", label: "Bad Label" })).toThrow(/label/);
    expect(() => planAnchor({ ...base, carrier: "token2022_metadata", subject: "batch", label: "a-very-long-dataset-name-indeed" })).toThrow(/shorter label/);
    expect(() => planAnchor({ ...base, carrier: "bubblegum_v1_leaf", subject: "batch", label: "x", documentBaseUrl: "http://insecure" })).toThrow(/https/);
    expect(() => planAnchor({ ...base, carrier: "bubblegum_v1_leaf", subject: "batch", label: "x", documentBaseUrl: `https://${"a".repeat(150)}.org` })).toThrow(/longer than/);
  });
});
