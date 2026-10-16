/**
 * NFT metadata rules.
 *
 * NFTs in this application are digital collectibles or in-app utility only.
 * They do not represent land, crops, revenue, or any real-world right. This
 * module enforces that in two ways:
 *   1. a fixed metadata shape (see nft-metadata.schema.json), and
 *   2. a content filter that rejects language implying ownership, returns or
 *      value guarantees, and rejects anything that looks like a location or
 *      personal data, since metadata is public and permanent once referenced
 *      on-chain.
 */

import type { ProvenanceLabel } from "./provenance";

export const NFT_METADATA_SCHEMA_VERSION = "1.0.0";

export const NFT_ASSET_TYPES = ["project-collectible", "scene-item", "badge"] as const;
export type NftAssetType = (typeof NFT_ASSET_TYPES)[number];

export const NFT_UTILITIES = [
  "display-in-3d-scene",
  "profile-badge",
  "unlock-cosmetic-theme",
  "commemorative",
] as const;
export type NftUtility = (typeof NFT_UTILITIES)[number];

export interface NftMetadata {
  schema_version: typeof NFT_METADATA_SCHEMA_VERSION;
  asset_type: NftAssetType;
  name: string;
  description: string;
  image?: string;
  application_utility: NftUtility[];
  provenance_label: ProvenanceLabel;
  source_timestamp: string;
  license_reference: string;
  terms_url: string;
  /** Required, fixed disclosure. Validated verbatim. */
  disclosure: typeof NFT_DISCLOSURE;
  attributes?: { trait_type: string; value: string | number }[];
}

export const NFT_DISCLOSURE =
  "Digital collectible for use within the application only. Does not convey land title, crop ownership, " +
  "profit share, or any real-world right, and carries no promise of value.";

/**
 * Phrases that must not appear in names, descriptions or attributes. Matched
 * case-insensitively on word boundaries. The fixed `disclosure` field is
 * exempt because it necessarily names what the token is NOT.
 */
export const FORBIDDEN_NFT_PHRASES = [
  "land title",
  "title deed",
  "deed",
  "ownership",
  "owns the land",
  "own the land",
  "own land",
  "crop ownership",
  "own the crop",
  "harvest share",
  "profit",
  "profit share",
  "revenue share",
  "dividend",
  "yield",
  "return on investment",
  "roi",
  "investment",
  "invest",
  "guaranteed",
  "appreciat",
  "passive income",
  "earn",
  "fractional",
  "security",
  "redeemable",
];

const COORDINATE_PATTERN = /-?\d{1,3}\.\d{3,}\s*[,; ]\s*-?\d{1,3}\.\d{3,}/;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const FORBIDDEN_KEYS = /^(lat|lon|lng|latitude|longitude|coordinates?|geometry|boundary|gps|address|owner_?name|email|phone|deed|parcel_?id|sensor_?(id|key|token|secret)|wallet_?owner|user_?id)$/i;

export interface NftContentIssue {
  field: string;
  message: string;
}

function scanText(field: string, text: string, issues: NftContentIssue[]) {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_NFT_PHRASES) {
    const re = new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (re.test(lower)) {
      issues.push({ field, message: `contains prohibited language: "${phrase}"` });
    }
  }
  if (COORDINATE_PATTERN.test(text)) issues.push({ field, message: "must not contain coordinates" });
  if (EMAIL_PATTERN.test(text)) issues.push({ field, message: "must not contain personal contact data" });
}

/** Content-level checks; run after structural schema validation. */
export function checkNftMetadataContent(m: NftMetadata): NftContentIssue[] {
  const issues: NftContentIssue[] = [];
  if (m.disclosure !== NFT_DISCLOSURE) issues.push({ field: "disclosure", message: "must be the standard disclosure text" });
  if (m.provenance_label === "independently-verified") {
    issues.push({ field: "provenance_label", message: "on-chain metadata must not claim independent verification" });
  }
  scanText("name", m.name, issues);
  scanText("description", m.description, issues);
  for (const [i, a] of (m.attributes ?? []).entries()) {
    if (FORBIDDEN_KEYS.test(a.trait_type)) {
      issues.push({ field: `attributes[${i}].trait_type`, message: "attribute is not allowed in public metadata" });
    }
    scanText(`attributes[${i}].trait_type`, a.trait_type, issues);
    scanText(`attributes[${i}].value`, String(a.value), issues);
  }
  return issues;
}
