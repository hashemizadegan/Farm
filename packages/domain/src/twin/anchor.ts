/**
 * Reserved on-chain anchor formats for Merkle roots (data-commitment batches and farm snapshots).
 * An anchor plan says exactly what would be written on-chain, so its format can be reviewed and
 * tested now, but it is data only: nothing here builds, signs or sends a transaction, and every
 * plan says `executable: false`.
 *
 * Two carriers are reserved:
 * - `token2022_metadata`: an additional metadata field on the farm's Token-2022 anchor mint
 *   (Token Metadata extension, `UpdateField` with a custom key); one field per dataset, value
 *   `<scheme>:<root>`.
 * - `bubblegum_v1_leaf`: a compressed NFT whose immutable leaf metadata points at a public anchor
 *   document that names the root; name ≤ 32 bytes, symbol ≤ 10, URI ≤ 200 (CNFT_METADATA_LIMITS).
 */
import { networkAllowed, type Network } from "../rwa/model";
import { CNFT_METADATA_LIMITS } from "../rwa/cnft";
import { MERKLE_SCHEME, isSha256Hex } from "./commitments";
import { SNAPSHOT_SCHEME } from "./snapshot";

export const ANCHOR_SCHEME = "metafarm-anchor/1";
export const ANCHOR_CARRIERS = ["token2022_metadata", "bubblegum_v1_leaf"] as const;
export type AnchorCarrier = (typeof ANCHOR_CARRIERS)[number];

/** What a root commits to. */
export const ANCHOR_SUBJECTS = { batch: MERKLE_SCHEME, snapshot: SNAPSHOT_SCHEME } as const;
export type AnchorSubject = keyof typeof ANCHOR_SUBJECTS;

/** Token Metadata field keys and values are Borsh strings; kept short so the account stays small. */
export const TOKEN2022_ANCHOR_LIMITS = { key: 32, value: 128 } as const;

export interface AnchorPlan {
  scheme: typeof ANCHOR_SCHEME;
  carrier: AnchorCarrier;
  network: Network;
  subject: AnchorSubject;
  root: string;
  /** Token-2022: the metadata field to set. */
  metadataField?: { key: string; value: string };
  /** Bubblegum V1: the leaf metadata to mint. */
  leafMetadata?: { name: string; symbol: string; uri: string };
  executable: false;
  reason: "anchoring_not_enabled";
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;
const DATASET = /^[a-z0-9][a-z0-9._/-]{0,99}$/;

export function planAnchor(p: {
  carrier: AnchorCarrier;
  network: Network;
  subject: AnchorSubject;
  root: string;
  /** Dataset name (batches) or farm id (snapshots); becomes the metadata key or the document path. */
  label: string;
  /** Base of the public anchor document URL (Bubblegum carrier). */
  documentBaseUrl?: string;
  mainnetEnabled: boolean;
}): AnchorPlan {
  if (!(ANCHOR_CARRIERS as readonly string[]).includes(p.carrier)) throw new RangeError("unknown anchor carrier");
  if (!p.network.startsWith("solana-")) throw new RangeError("anchors are reserved on Solana only");
  if (!networkAllowed(p.network, { mainnetEnabled: p.mainnetEnabled })) throw new RangeError(`${p.network} is not enabled`);
  if (!isSha256Hex(p.root)) throw new RangeError("root must be 64 lowercase hex characters");
  if (!DATASET.test(p.label)) throw new RangeError("label must be a dataset name or id (lowercase, digits, . _ / -)");
  const base: Omit<AnchorPlan, "metadataField" | "leafMetadata"> = { scheme: ANCHOR_SCHEME, carrier: p.carrier, network: p.network, subject: p.subject, root: p.root, executable: false, reason: "anchoring_not_enabled" };

  if (p.carrier === "token2022_metadata") {
    // Never truncated: two labels must not collapse into the same key.
    const key = `mf:${p.subject}:${p.label}`;
    if (utf8Length(key) > TOKEN2022_ANCHOR_LIMITS.key) throw new RangeError(`the metadata key ${key} is longer than ${TOKEN2022_ANCHOR_LIMITS.key} bytes; use a shorter label`);
    const value = `${ANCHOR_SUBJECTS[p.subject]}:${p.root}`;
    if (utf8Length(value) > TOKEN2022_ANCHOR_LIMITS.value) throw new RangeError("anchor value too long");
    return { ...base, metadataField: { key, value } };
  }

  if (!p.documentBaseUrl || !/^https:\/\//.test(p.documentBaseUrl)) throw new RangeError("a Bubblegum anchor needs an https document base URL");
  const uri = `${p.documentBaseUrl.replace(/\/+$/, "")}/v1/public/anchors/${p.root}`;
  if (utf8Length(uri) > CNFT_METADATA_LIMITS.uri) throw new RangeError(`the anchor URI is longer than ${CNFT_METADATA_LIMITS.uri} bytes`);
  const leafMetadata = { name: `MF ${p.subject} ${p.root.slice(0, 12)}`, symbol: "MFANCHOR", uri };
  if (utf8Length(leafMetadata.name) > CNFT_METADATA_LIMITS.name || utf8Length(leafMetadata.symbol) > CNFT_METADATA_LIMITS.symbol) throw new RangeError("leaf metadata too long");
  return { ...base, leafMetadata };
}
