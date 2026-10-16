/**
 * Contract tests: the OpenAPI document and NFT metadata schema stay in sync
 * with the domain constants that the API actually enforces.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  METRICS,
  NFT_ASSET_TYPES,
  NFT_DISCLOSURE,
  NFT_UTILITIES,
  PROVENANCE_LABELS,
  ROLES,
} from "@metafarm/domain";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = parse(readFileSync(path.join(root, "openapi.yaml"), "utf8"));
const nftSchema = JSON.parse(readFileSync(path.join(root, "nft-metadata.schema.json"), "utf8"));
const schemas = spec.components.schemas;

describe("openapi.yaml", () => {
  it("is OpenAPI 3.1 with unique operation ids", () => {
    expect(spec.openapi).toBe("3.1.0");
    const ids: string[] = [];
    for (const item of Object.values<Record<string, { operationId?: string }>>(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) ids.push(op.operationId!);
      }
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts every tenant resource under /v1/tenants/{tenantId}", () => {
    const tenantScoped = Object.keys(spec.paths).filter(
      (p) => p.startsWith("/v1/") && !p.startsWith("/v1/me") && !p.startsWith("/v1/wallet") && !p.startsWith("/v1/webhooks"),
    );
    expect(tenantScoped.every((p) => p.startsWith("/v1/tenants/{tenantId}/"))).toBe(true);
  });

  it("matches domain provenance labels and roles", () => {
    expect(schemas.ProvenanceLabel.enum).toEqual([...PROVENANCE_LABELS]);
    expect(schemas.Role.enum).toEqual([...ROLES]);
  });

  it("matches observation metrics", () => {
    expect(schemas.ObservationInput.properties.metric.enum.sort()).toEqual(Object.keys(METRICS).sort());
  });

  it("only allows simulated scenarios", () => {
    expect(schemas.CropScenario.properties.kind.enum).toEqual(["simulated"]);
  });
});

describe("nft-metadata.schema.json", () => {
  it("matches the domain constants", () => {
    expect(nftSchema.properties.asset_type.enum).toEqual([...NFT_ASSET_TYPES]);
    expect(nftSchema.properties.application_utility.items.enum).toEqual([...NFT_UTILITIES]);
    expect(nftSchema.properties.disclosure.const).toBe(NFT_DISCLOSURE);
  });

  it("forbids claiming independent verification on-chain", () => {
    expect(nftSchema.properties.provenance_label.enum).not.toContain("independently-verified");
  });

  it("requires every field the spec lists", () => {
    for (const f of [
      "schema_version",
      "asset_type",
      "name",
      "application_utility",
      "provenance_label",
      "source_timestamp",
      "license_reference",
      "terms_url",
    ]) {
      expect(nftSchema.required).toContain(f);
    }
    expect(nftSchema.additionalProperties).toBe(false);
  });
});
