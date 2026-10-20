/**
 * What a compressed NFT says about the asset it represents. Leaf metadata is public on chain
 * forever, so it carries no coordinates or personal data: the leaf's URI points at a document that
 * commits to the canonical asset record by a salted hash (the salt stays in the database), and the
 * record itself is shown only to whoever the operator chooses to show it to.
 */
import { canonicalJson } from "../harvest";
import type { AssetKind } from "./model";

/** Bubblegum V1's limits on the metadata a leaf commits to, in UTF-8 bytes. */
export const CNFT_METADATA_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

/** Identifies how the commitment was computed, so a verifier can recompute it. */
export const ASSET_COMMITMENT_SCHEME = "metafarm-rwa-asset/1";

const SYMBOLS: Partial<Record<AssetKind, string>> = {
  parcel: "PARCEL",
  tree: "TREE",
  livestock: "LIVESTOCK",
};

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** The longest prefix of `s` that fits in `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (utf8Length(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** The asset facts a leaf commits to. Geometry is GeoJSON as stored (PostGIS output). */
export interface AssetCommitmentRecord {
  assetId: string;
  kind: AssetKind;
  externalRef: string | null;
  parcelLabel: string | null;
  geometry: object | null;
  geomProvenance: string | null;
  verifiedAt: string | null;
}

/** The exact bytes hashed: the salt, then the canonical record (with its scheme). */
export function commitmentPreimage(saltHex: string, record: AssetCommitmentRecord): string {
  if (!/^[0-9a-f]{32,}$/.test(saltHex)) throw new RangeError("salt must be at least 16 random bytes, hex");
  return `${saltHex}:${canonicalJson({ scheme: ASSET_COMMITMENT_SCHEME, ...record })}`;
}

export interface CnftMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * The name, symbol and URI a registration's leaf will carry, checked against the program's limits.
 * The URI is `<base>/v1/public/rwa/cnft/<representationId>`.
 */
export function cnftMetadataFor(
  asset: { kind: AssetKind; name: string },
  baseUrl: string,
  representationId: string,
): CnftMetadata {
  const symbol = SYMBOLS[asset.kind];
  if (!symbol) throw new RangeError(`${asset.kind} assets are not represented as compressed NFTs`);
  const uri = `${baseUrl.replace(/\/+$/, "")}/v1/public/rwa/cnft/${representationId}`;
  if (!/^https:\/\//.test(uri) && !/^http:\/\/localhost[:/]/.test(uri))
    throw new RangeError("the metadata URI must be https");
  if (utf8Length(uri) > CNFT_METADATA_LIMITS.uri)
    throw new RangeError(
      `the metadata URI is longer than ${CNFT_METADATA_LIMITS.uri} bytes; use a shorter base URL`,
    );
  const name = truncateUtf8(asset.name.trim(), CNFT_METADATA_LIMITS.name);
  if (!name) throw new RangeError("the asset needs a name");
  return { name, symbol, uri };
}
