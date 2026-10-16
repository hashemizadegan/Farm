import { describe, expect, it } from "vitest";
import { NFT_DISCLOSURE, NFT_METADATA_SCHEMA_VERSION, checkNftMetadataContent, type NftMetadata } from "./nft";

const ok: NftMetadata = {
  schema_version: NFT_METADATA_SCHEMA_VERSION,
  asset_type: "scene-item",
  name: "Copper Weather Vane",
  description: "A decorative weather vane you can place in your 3D farm scene.",
  application_utility: ["display-in-3d-scene"],
  provenance_label: "illustrative",
  source_timestamp: "2026-01-01T00:00:00Z",
  license_reference: "CC-BY-4.0",
  terms_url: "https://example.com/terms",
  disclosure: NFT_DISCLOSURE,
};

describe("checkNftMetadataContent", () => {
  it("accepts collectible-only language", () => {
    expect(checkNftMetadataContent(ok)).toEqual([]);
  });

  it.each([
    "Owns the land at plot 7",
    "Includes a profit share",
    "Guaranteed to appreciate",
    "Represents crop ownership of this harvest",
    "Earn passive income",
    "Land title token",
    "Great investment",
  ])("rejects prohibited language: %s", (description) => {
    expect(checkNftMetadataContent({ ...ok, description }).length).toBeGreaterThan(0);
  });

  it("rejects coordinates and personal data", () => {
    expect(checkNftMetadataContent({ ...ok, description: "Located at 51.50735, -0.12776" }).length).toBeGreaterThan(0);
    expect(checkNftMetadataContent({ ...ok, description: "Contact farmer@example.com" }).length).toBeGreaterThan(0);
    expect(
      checkNftMetadataContent({ ...ok, attributes: [{ trait_type: "latitude", value: 51.5 }] }).length,
    ).toBeGreaterThan(0);
    expect(
      checkNftMetadataContent({ ...ok, attributes: [{ trait_type: "sensor_key", value: "abc" }] }).length,
    ).toBeGreaterThan(0);
  });

  it("requires the verbatim disclosure and forbids verification claims", () => {
    expect(checkNftMetadataContent({ ...ok, disclosure: "whatever" as never }).length).toBeGreaterThan(0);
    expect(checkNftMetadataContent({ ...ok, provenance_label: "independently-verified" }).length).toBeGreaterThan(0);
  });

  it("does not trip on words that merely contain a prohibited fragment", () => {
    expect(checkNftMetadataContent({ ...ok, description: "Learn about the weather vane." })).toEqual([]);
  });
});
