import { describe, expect, it } from "vitest";
import {
  ASSET_COMMITMENT_SCHEME,
  CNFT_METADATA_LIMITS,
  cnftMetadataFor,
  commitmentPreimage,
  truncateUtf8,
} from "./cnft";
import { createRegistrationSchema } from "./requests";

const REP = "6f1c1c3e-2a9b-4c5d-8e7f-0a1b2c3d4e5f";
const SALT = "00112233445566778899aabbccddeeff";

describe("cNFT metadata", () => {
  it("names, symbols and points the URI at the public metadata endpoint", () => {
    expect(
      cnftMetadataFor({ kind: "tree", name: " Pistachio A-17 " }, "https://api.example.com/", REP),
    ).toEqual({
      name: "Pistachio A-17",
      symbol: "TREE",
      uri: `https://api.example.com/v1/public/rwa/cnft/${REP}`,
    });
  });
  it("fits the name in 32 bytes without splitting a character", () => {
    const persian = "درخت پسته شماره هفده در باغ شمالی";
    const m = cnftMetadataFor({ kind: "tree", name: persian }, "https://api.example.com", REP);
    expect(new TextEncoder().encode(m.name).length).toBeLessThan(CNFT_METADATA_LIMITS.name + 1);
    expect(persian.startsWith(m.name)).toBe(true);
    expect(truncateUtf8("ab€", 4)).toBe("ab");
  });
  it("refuses kinds that are share tokens, non-https URIs and over-long URIs", () => {
    expect(() => cnftMetadataFor({ kind: "farm_share", name: "x" }, "https://a.example", REP)).toThrow();
    expect(() => cnftMetadataFor({ kind: "parcel", name: "x" }, "http://a.example", REP)).toThrow();
    expect(() =>
      cnftMetadataFor({ kind: "parcel", name: "x" }, `https://${"a".repeat(180)}.example`, REP),
    ).toThrow();
    expect(cnftMetadataFor({ kind: "livestock", name: "x" }, "http://localhost:4000", REP).symbol).toBe(
      "LIVESTOCK",
    );
  });
});

describe("asset commitment", () => {
  const record = {
    assetId: REP,
    kind: "tree" as const,
    externalRef: "A-17",
    parcelLabel: null,
    geometry: { type: "Point", coordinates: [56.01, 30.4] },
    geomProvenance: "gnss",
    verifiedAt: "2026-10-20T00:00:00.000Z",
  };
  it("is the salt, then the canonical record with its scheme", () => {
    const p = commitmentPreimage(SALT, record);
    expect(p.startsWith(`${SALT}:{`)).toBe(true);
    expect(p).toContain(`"scheme":"${ASSET_COMMITMENT_SCHEME}"`);
    expect(
      commitmentPreimage(SALT, { ...record, geometry: { coordinates: [56.01, 30.4], type: "Point" } }),
    ).toBe(p);
  });
  it("needs a real salt", () => {
    expect(() => commitmentPreimage("abc", record)).toThrow();
  });
});

describe("registration request", () => {
  it("takes a Solana network, a custodian party and its wallet, nothing else", () => {
    const ok = { network: "solana-devnet", partyId: REP, solanaWallet: "11111111111111111111111111111111" };
    expect(createRegistrationSchema.safeParse(ok).success).toBe(true);
    expect(createRegistrationSchema.safeParse({ ...ok, network: "tron-nile" }).success).toBe(false);
    expect(createRegistrationSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
