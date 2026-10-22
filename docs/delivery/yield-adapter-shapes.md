# Yield adapter shapes (frozen reference)

**What this is.** The exact data shapes the ownership-index line hands to the yield line's simulation pipeline
since the line join (PR #96), with the code each comes from, canonical JSON examples, the validation rules and the
refusal codes that depend on them. Documentation only: it changes no behaviour. When code and this document
disagree, the code wins and this document is stale. The line references are for commit `d35bb4c` on
`integration/yield-ownership-join`.

**Canonical JSON** (every hash below): `canonicalYieldArtifact` (`packages/domain/src/yield/artifact.ts`) =
`canonicalJson` (`packages/domain/src/harvest.ts` lines 91–100: keys sorted by UTF-16 code unit, no whitespace,
`undefined` dropped) over `toCanonicalValue` (bigints as decimal strings; non-integer numbers refused). Hash =
lowercase hex SHA-256 of the UTF-8 bytes. The examples below come from the repository's own fixtures (generated, not
hand-written). They are shown indented for reading; the canonical form is the same keys, in the same order, with no
whitespace. The carry ledger is shown exactly as stored.

**Versioning.** Every shape is versioned by a scheme string; a change of meaning needs a new scheme, never a
silent edit:

| Scheme | Shape |
| --- | --- |
| `metafarm-yield-ownership-snapshot/1` | verified ownership snapshot (§1) |
| `metafarm-yield-leaf/1` (domain tag), leaf layouts 1 and 2 | claim leaf (§2) |
| `metafarm-yield-claim-tree/1` | claim tree |
| `metafarm-yield-evidence/1` | evidence manifest (§3) |
| `metafarm-yield-distribution-plan/1` | distribution plan, ledgers (§4) |
| `metafarm-yield-cycle-artifact/1` | frozen cycle artifact (§5) |
| `metafarm-yield-simulation-dossier/1` | simulation dossier (§6) |
| `metafarm-weighted-ownership/1` | Y5 weighted ownership input (§7) |

Stable field names: camelCase in TypeScript and JSON; snake_case only in SQL. Amounts are integers in minor or base
units, never floating point.

## 0. The adapter in one table

| From (ownership-index line) | Adapter (`apps/api/src/lib/yield-pipeline-engine.ts`) | To (yield line) |
| --- | --- | --- |
| `WeightedOwnershipInput` (Y5) | `snapshotInput` (line 92): parties → entries (`rawShares` = slot weight, ≤ u64), unattributed → unattributed, `networkId: "simulation"`, `reference.slot` = window end, snapshot id from the input commitment (`uuidFromDigest`, line 50) | `OwnershipSnapshotInput` → `verifyAndNormalizeSnapshot` |
| locked cycle + inputs + evidence hashes (DB) + dossier | `checkBindings` (line 60): policy hash, entitlement, currency, formula, settlement, every line, every evidence hash | `SimulationCycleInput` |
| predecessor's carry-out (0028) | `req.carryIn` (hash checked) | `distributionLedger` (`plan.ledgerIn`) |
| `CycleDistributionArtifact` | `allocationsOf` (line 123), canonical body, leaves, ledgers | `yield_artifact_sets`, `yield_allocations`, `yield_frozen_artifacts`, `yield_claim_leaves`, `yield_carry_ledgers` |

## 1. Ownership snapshot (as the pipeline consumes it)
`packages/domain/src/yield/ownership-snapshot.ts` lines 30–50:

```ts
export const OWNERSHIP_SNAPSHOT_SCHEME = "metafarm-yield-ownership-snapshot/1";

/** The only network identifiers a snapshot may name. Real networks are refused (simulation only). */
export const SIMULATION_NETWORK_IDS = ["simulation", "solana-localnet"] as const;
export type SimulationNetworkId = (typeof SIMULATION_NETWORK_IDS)[number];

export const SNAPSHOT_REFERENCE_KINDS = ["slot", "block_height"] as const;

export interface OwnershipSnapshotInput {
  /** Lowercase RFC 4122 UUID. */
  snapshotId: string;
  /** The economic asset (Token-2022 mint or compressed-NFT id): base58 or 64 hex, 32 bytes. */
  assetId: string;
  networkId: string;
  /** Where in the chain's history the snapshot was taken, and when that point was observed. */
  reference: { kind: (typeof SNAPSHOT_REFERENCE_KINDS)[number]; value: bigint; observedAt: string };
  /** Canonical order: ascending party id. */
  entries: { partyId: string; payoutAddress: string | null; rawShares: bigint; metadata?: Record<string, string> }[];
  /** Holdings no party is attributed to. Canonical order: ascending holder key. */
  unattributed: { holderKey: string; rawShares: bigint }[];
}
```
`packages/domain/src/yield/ownership-snapshot.ts` lines 52–90:

```ts
export interface VerifiedOwnershipEntry {
  partyId: string;
  /** The address as supplied, or null when the party has none. */
  payoutAddress: string | null;
  /** Hex of the address's 32 bytes, or null. */
  recipient: string | null;
  rawShares: bigint;
  metadata: Record<string, string> | null;
  /** The party's exact proportional basis: rawShares / totalRawShares, kept as integers. */
  shareBasis: { numerator: bigint; denominator: bigint };
}

export interface VerifiedOwnershipSnapshot {
  scheme: typeof OWNERSHIP_SNAPSHOT_SCHEME;
  snapshotId: string;
  /** Hex of the asset's 32 bytes. */
  assetId: string;
  networkId: SimulationNetworkId;
  reference: { kind: (typeof SNAPSHOT_REFERENCE_KINDS)[number]; value: bigint; observedAt: string };
  snapshotHash: string;
  totalRawShares: bigint;
  entries: VerifiedOwnershipEntry[];
  unattributed: { holderKey: string; rawShares: bigint; shareBasis: { numerator: bigint; denominator: bigint } }[];
  /** Supplied by the caller (the library reads no clock). */
  verifiedAt: string;
  diagnostics: { partyCount: number; withheldCount: number; unattributedCount: number; unattributedRawShares: bigint; minRawShares: bigint; maxRawShares: bigint };
}

export type OwnershipSnapshotErrorCode =
  | "invalid_snapshot"
  | "real_network"
  | "invalid_shares"
  | "duplicate_party"
  | "duplicate_payout_address"
  | "duplicate_holder"
  | "not_canonical_order"
  | "zero_total"
  | "hash_mismatch";

```

**Rules** (`verifyAndNormalizeSnapshot`, line 156; `ownershipSnapshotProblems`, line 261; each refusal is an
`OwnershipSnapshotError` with the codes above):
- `networkId` ∈ `SIMULATION_NETWORK_IDS` (`simulation`, `solana-localnet`); any real network → `real_network`.
  This is why the engine refuses RPC (devnet) ownership as `real_network_ownership` and **must keep doing so**
  until the Y15 devnet approval;
- `0 < rawShares ≤ 2^64 − 1` (u64); the total is an exact sum > 0 (`invalid_shares`, `zero_total`). The adapter
  refuses Y5 weights above u64 first (`weight_exceeds_u64`);
- party ids unique and **already** in ascending UTF-16 order, as are unattributed holder keys
  (`not_canonical_order`; never re-sorted silently). Y5 emits both in that order;
- payout addresses: base58 or 64 hex, 32 bytes, unique after normalisation (`duplicate_payout_address`); `null`
  means none (withheld or refused, per the distribution policy, D-14);
- unsupported keys are refused (`invalid_snapshot`);
- the commitment (`snapshotHash`) covers scheme, id, asset (hex), network, reference, entries (recipient hex) and
  unattributed. The address spelling, `verifiedAt` and the diagnostics are not covered.

**Minimal input:**
```json
{
  "assetId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "entries": [
    {
      "partyId": "party-a",
      "payoutAddress": null,
      "rawShares": "1"
    }
  ],
  "networkId": "simulation",
  "reference": {
    "kind": "slot",
    "observedAt": "2026-03-31T23:59:59Z",
    "value": "200"
  },
  "snapshotId": "00000000-0000-4000-8000-0000000000e1",
  "unattributed": []
}
```

**Full input** (the pipeline scenario, `pipeline.scenario.test-support.ts`):

```json
{
  "assetId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "entries": [
    {
      "partyId": "party-a",
      "payoutAddress": "0101010101010101010101010101010101010101010101010101010101010101",
      "rawShares": "50"
    },
    {
      "partyId": "party-b",
      "payoutAddress": "So11111111111111111111111111111111111111112",
      "rawShares": "30"
    },
    {
      "partyId": "party-c",
      "payoutAddress": null,
      "rawShares": "15"
    },
    {
      "metadata": {
        "note": "simulation holder"
      },
      "partyId": "party-d",
      "payoutAddress": "0303030303030303030303030303030303030303030303030303030303030303",
      "rawShares": "1"
    }
  ],
  "networkId": "simulation",
  "reference": {
    "kind": "slot",
    "observedAt": "2026-09-30T23:59:59Z",
    "value": "123456789"
  },
  "snapshotId": "00000000-0000-4000-8000-0000000000e1",
  "unattributed": [
    {
      "holderKey": "token-account-x",
      "rawShares": "4"
    }
  ]
}
```

**Verified snapshot** (the same input after verification):

```json
{
  "assetId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "diagnostics": {
    "maxRawShares": "50",
    "minRawShares": "1",
    "partyCount": 4,
    "unattributedCount": 1,
    "unattributedRawShares": "4",
    "withheldCount": 1
  },
  "entries": [
    {
      "metadata": null,
      "partyId": "party-a",
      "payoutAddress": "0101010101010101010101010101010101010101010101010101010101010101",
      "rawShares": "50",
      "recipient": "0101010101010101010101010101010101010101010101010101010101010101",
      "shareBasis": {
        "denominator": "100",
        "numerator": "50"
      }
    },
    {
      "metadata": null,
      "partyId": "party-b",
      "payoutAddress": "So11111111111111111111111111111111111111112",
      "rawShares": "30",
      "recipient": "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
      "shareBasis": {
        "denominator": "100",
        "numerator": "30"
      }
    },
    {
      "metadata": null,
      "partyId": "party-c",
      "payoutAddress": null,
      "rawShares": "15",
      "recipient": null,
      "shareBasis": {
        "denominator": "100",
        "numerator": "15"
      }
    },
    {
      "metadata": {
        "note": "simulation holder"
      },
      "partyId": "party-d",
      "payoutAddress": "0303030303030303030303030303030303030303030303030303030303030303",
      "rawShares": "1",
      "recipient": "0303030303030303030303030303030303030303030303030303030303030303",
      "shareBasis": {
        "denominator": "100",
        "numerator": "1"
      }
    }
  ],
  "networkId": "simulation",
  "reference": {
    "kind": "slot",
    "observedAt": "2026-09-30T23:59:59Z",
    "value": "123456789"
  },
  "scheme": "metafarm-yield-ownership-snapshot/1",
  "snapshotHash": "bb57ff8d4fcf9adbfae0d505004022e73cbd1535848641fde2c493bf884d5ddd",
  "snapshotId": "00000000-0000-4000-8000-0000000000e1",
  "totalRawShares": "100",
  "unattributed": [
    {
      "holderKey": "token-account-x",
      "rawShares": "4",
      "shareBasis": {
        "denominator": "100",
        "numerator": "4"
      }
    }
  ],
  "verifiedAt": "2026-10-01T09:00:00Z"
}
```

## 2. Leaf context (every input that shapes a claim leaf)
`packages/domain/src/yield/claim-tree.ts` lines 158–190:

```ts
export interface ClaimLeafContext {
  /** u8 network registry constant. */
  networkId: number;
  /** 32 bytes: the cluster's genesis hash recorded by Y0 (not built; supplied by the caller). */
  clusterIdentity: string;
  /** u32 (0 when unused). */
  epoch: number;
  /** 32 bytes: the Token-2022 mint or compressed-NFT asset id. */
  economicAssetId: string;
  /** 32 bytes: the settlement token's mint. */
  payoutMint: string;
  /** u16 version of the yield formula. */
  formulaVersion: number;
  /** 64 lowercase hex: the ownership snapshot hash. Required for layout 2, refused for layout 1. */
  ownershipSnapshotHash?: string;
}

export interface ClaimLeafFields {
  networkId: number;
  clusterIdentity: Uint8Array;
  cycleId: Uint8Array;
  cycleVersion: number;
  epoch: number;
  economicAssetId: Uint8Array;
  recipient: Uint8Array;
  payoutMint: Uint8Array;
  amount: bigint;
  formulaVersion: number;
  leafLayoutVersion: number;
  leafIndex: number;
  /** Layout 2 only: the 32-byte ownership snapshot hash. Absent for layout 1. */
  ownershipSnapshotHash?: Uint8Array;
}
```
`packages/domain/src/yield/claim-tree.ts` lines 69–92:

```ts
export interface ClaimTreePolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** The hasher a tree under this policy must use. Pending D-26. */
  hasherId: string;
  /** Leaf layout: 1 (plan §6.2), or 2 (bound to the ownership snapshot). */
  leafLayoutVersion: 1 | 2;
  /** Largest number of leaves in one tree (≤ 2^32). */
  maxLeaves: number;
}

/** Temporary defaults for **simulation cycles only**; a real cycle refuses this record (pending D-26). */
export const SIMULATION_CLAIM_TREE_POLICY: ClaimTreePolicy = Object.freeze({
  id: "simulation-claim-tree",
  version: 1,
  status: "simulation",
  hasherId: SHA256_RFC9162_HASHER.id, // pending D-26
  leafLayoutVersion: 1,
  maxLeaves: 65_536, // pending: an operational bound for simulation
});

/** As SIMULATION_CLAIM_TREE_POLICY, with leaves bound to the ownership snapshot (layout 2). Simulation only. */
export const SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND: ClaimTreePolicy = Object.freeze({ ...SIMULATION_CLAIM_TREE_POLICY, id: "simulation-claim-tree-snapshot-bound", leafLayoutVersion: 2 });
```
`packages/domain/src/yield/claim-tree.ts` lines 334–343:

```ts
export interface ClaimProof {
  leafIndex: number;
  treeSize: number;
  /** Hex. */
  leafHash: string;
  /** Hex sibling hashes, nearest first. */
  path: string[];
  /** Hex. */
  root: string;
}
```
`packages/domain/src/yield/claim-tree.ts` lines 415–427:

```ts
export interface ClaimLeaf {
  leafIndex: number;
  partyId: string;
  /** The payout wallet as given in the plan. */
  payoutWallet: string;
  /** Hex of the 32 recipient bytes. */
  recipient: string;
  amount: bigint;
  /** Hex of the 201 leaf bytes. */
  leafBytes: string;
  leafHash: string;
  proof: ClaimProof;
}
```

**Leaf bytes.** Integers are little-endian. Layout 1 is 201 bytes; layout 2 is the same 201 bytes with layout
version 2, followed by the 32-byte snapshot hash, for 233 bytes in total. Fields in order:

| Field | Bytes |
| --- | --- |
| domain tag = SHA-256(`metafarm-yield-leaf/1`) | 32 |
| network id | 1 |
| cluster identity | 32 |
| cycle id (UUID bytes) | 16 |
| cycle version (u32) | 4 |
| epoch (u32) | 4 |
| economic asset id | 32 |
| recipient | 32 |
| payout mint | 32 |
| amount (u64) | 8 |
| formula version (u16) | 2 |
| leaf-layout version (u16) | 2 |
| leaf index (u32) | 4 |
| snapshot hash (layout 2 only) | 32 |

**Hashing:**
- leaf hash = SHA-256(0x00 ‖ SHA-256(leaf bytes));
- node = SHA-256(0x01 ‖ left ‖ right);
- RFC 9162 tree shape (`SHA256_RFC9162_HASHER`, `sha256-rfc9162-double-leaf/1`; **pending D-26**);
- leaves are ordered by recipient bytes, one per payout wallet;
- only `payable` entries get a leaf.

**What the engine supplies** (simulation; real values come with Y6 final, D-26 [Ext] and Y0 live use):
- `networkId` 0;
- `clusterIdentity` 32 zero bytes (no verified cluster for fixture ownership);
- `epoch` 0;
- `economicAssetId` = the cycle's chain asset;
- `payoutMint` = the cycle's settlement mint;
- `formulaVersion` = index + 1 of the policy's formula in `YIELD_FORMULA_VERSIONS`;
- `ownershipSnapshotHash` = the verified snapshot's hash (layout 2).

**Errors:** `ClaimTreeError`: `invalid_input`, `invalid_key`, `duplicate_recipient`, `empty_tree`,
`too_many_leaves`, `hasher_mismatch`. A real cycle refuses the simulation policy (`YieldRecordError`).

**Leaf context of the scenario:**
```json
{
  "clusterIdentity": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "economicAssetId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "epoch": 0,
  "formulaVersion": 1,
  "networkId": 7
}
```

**One leaf with its proof** (scenario, party A):

```json
{
  "amount": "2677500000",
  "leafBytes": "8f24147acb60304b34971e8fea956387add8a1280ee6342be62679269a959a8307aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000000000400080000000000000c10100000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0101010101010101010101010101010101010101010101010101010101010101069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f000000000016068979f000000000100020000000000bb57ff8d4fcf9adbfae0d505004022e73cbd1535848641fde2c493bf884d5ddd",
  "leafHash": "55b427ba39e2860badd0b0a516e597de200e50d59704cd2e122a363fbee0f61f",
  "leafIndex": 0,
  "partyId": "party-a",
  "proof": {
    "leafHash": "55b427ba39e2860badd0b0a516e597de200e50d59704cd2e122a363fbee0f61f",
    "leafIndex": 0,
    "path": [
      "62a8074fa2b5e091b8a4fe1da179e90dcca7c62970ab4c18d50a361d9f65f6f3"
    ],
    "root": "63fe5c14a3039c5dce1c3a3811f1d51c71c0f4956c6552eebacf2c587885796b",
    "treeSize": 2
  },
  "recipient": "0101010101010101010101010101010101010101010101010101010101010101"
}
```

## 3. Evidence items (full metadata) and categories
`packages/domain/src/yield/evidence.ts` lines 16–58:

```ts

/** Evidence types of plan §5.2. */
export const EVIDENCE_TYPES = [
  "weighbridge_receipt",
  "warehouse_receipt",
  "sales_invoice",
  "customs_record",
  "bank_settlement_record",
  "stablecoin_settlement_record",
  "equipment_telemetry",
  "iot_data",
  "weather_data",
  "auditor_attestation",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Classifications used in plan §5.2. Evidence is never public; public outputs carry totals and hashes only. */
export const EVIDENCE_CLASSIFICATIONS = ["internal", "confidential", "restricted"] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

export interface EvidenceItem {
  type: EvidenceType;
  /** SHA-256 (lowercase hex) of the exact bytes. */
  contentSha256: string;
  /** Size of the exact bytes. */
  byteSize: number;
  /** IANA media type, e.g. `application/pdf`. */
  mediaType: string;
  /** When the document was issued: RFC 3339 with an offset. */
  issuedAt: string;
  /** IANA time zone for documents dated in local time, or null when the document is not local-dated. */
  timeZone: string | null;
  /** Identifier of the source (e.g. an invoice number); a source backs at most one live input (plan §3.4). */
  sourceId: string;
  recordedBy: string;
  /** RFC 3339 with an offset. */
  recordedAt: string;
  classification: EvidenceClassification;
  /** Retention class by id (D-24). Required; never defaulted. */
  retentionClassId: string;
  /** The content hash of the item this one corrects, or null. */
  supersedes: string | null;
}
```

**Rules** (`evidenceItemProblems`, line 108):
- every key is required; `timeZone` and `supersedes` take `null` for none;
- `contentSha256` is 64 lowercase hex;
- `byteSize` is a safe integer ≥ 0;
- `mediaType` is a lowercase `type/subtype` with no parameters;
- `issuedAt` and `recordedAt` are RFC 3339 with an offset (real calendar values; no leap seconds);
- `timeZone` is an IANA zone or `null`;
- an item cannot supersede itself;
- in a ledger (`registerEvidence`, `evidence-store.ts`), `retentionClassId` must be one the storage policy
  allows. The simulation policy allows only `simulation-retention` (D-24).

Ledger errors: `invalid_policy`, `storage_ref`, `retention_class`, `conflict`, `committed`, `supersession`,
`missing_bytes`, `ledger_corrupt`.

**Known gap between the two lines** (documented, not reconciled in code):
- the database's `yield_evidence.classification` is `public | internal | confidential | personal` (0024);
- the domain's is `internal | confidential | restricted`;
- `yield_evidence.evidence_type` is free text in the database, while the domain's is `EVIDENCE_TYPES`.

The engine takes each item's full metadata from the dossier, and binds it to the database only by
`contentSha256`. Aligning the two vocabularies is a schema change for a later stage.

**Evidence item** (scenario):
```json
{
  "byteSize": 10,
  "classification": "confidential",
  "contentSha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "issuedAt": "2026-09-30T10:00:00+03:30",
  "mediaType": "application/pdf",
  "recordedAt": "2026-10-01T08:00:00Z",
  "recordedBy": "preparer-1",
  "retentionClassId": "simulation-retention",
  "sourceId": "INV-USD-1",
  "supersedes": null,
  "timeZone": "Asia/Tehran",
  "type": "sales_invoice"
}
```

## 4. Line categories and the distribution taxonomy
`packages/domain/src/yield/aggregation.ts` lines 27–43:

```ts
export const EVIDENCE_LINE_CATEGORIES = ["gross_revenue", "refund", "chargeback", "rebate", "tax_collected", "operating_expense"] as const;
export type EvidenceLineCategory = (typeof EVIDENCE_LINE_CATEGORIES)[number];

export interface EvidenceLine {
  /** Unique within the cycle. Becomes the cost-line id for expenses. */
  lineId: string;
  /** The evidence item (in the cycle's manifest) this amount comes from. */
  evidenceSha256: string;
  category: EvidenceLineCategory;
  /** Minor units of `currency`; null only when `completeness` is `unknown` (expenses only). */
  amount: bigint | null;
  currency: { code: string; exponent: number };
  /** `known` for revenue-side lines; expenses may also be `zero`, `estimated` or `unknown` (plan §3.7). */
  completeness: CostCompleteness;
  /** Required when `currency` differs from the accounting currency; null when it is the same. */
  rate: RationalRate | null;
}
```
`packages/domain/src/yield/waterfall.ts` lines 24–25:

```ts
export const COST_COMPLETENESS = ["known", "zero", "estimated", "unknown"] as const;
export type CostCompleteness = (typeof COST_COMPLETENESS)[number];
```
`packages/domain/src/yield/distribution.ts` lines 31–67:

```ts
export const MISSING_PAYOUT_WALLET_RULES = ["refuse_cycle", "withhold"] as const;
export type MissingPayoutWalletRule = (typeof MISSING_PAYOUT_WALLET_RULES)[number];

export interface DistributionPolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** Pending D-9. */
  remainder: RemainderRule;
  /** Settlement base units; a party's amount strictly below this is deferred. Pending D-9. */
  dustThreshold: bigint;
  /** Pending D-14. */
  missingPayoutWallet: MissingPayoutWalletRule;
}

/**
 * Temporary defaults for **simulation cycles only** (status `simulation`). A real cycle refuses this
 * record, so none of these values can reach a real distribution before its decision is approved.
 */
export const SIMULATION_DISTRIBUTION_POLICY: DistributionPolicy = Object.freeze({
  id: "simulation-distribution-defaults",
  version: 1,
  status: "simulation",
  remainder: "largest_remainder", // pending D-9: the plan's provisional recommendation, simulation only
  dustThreshold: 0n, // pending D-9: no dust threshold in simulation
  missingPayoutWallet: "withhold", // pending D-14 (§13.2 Q2): simulation only
});

export type DistributionShare = { kind: "party"; partyId: string; payoutWallet: string | null; weight: bigint } | { kind: "unattributed"; holderKey: string; weight: bigint };

/** Carried from the previous cycle's plan (empty for a first cycle). */
export interface DistributionLedger {
  /** Remainder carried by the `carry` rule. */
  carriedRemainder: bigint;
  /** Deferred dust per party, unique party ids. */
  deferred: { partyId: string; amount: bigint }[];
}
```
`packages/domain/src/yield/distribution.ts` lines 74–120:

```ts
export const DISTRIBUTION_ENTRY_STATES = ["payable", "deferred", "withheld", "unattributed", "carried", "claimed", "voided", "expired", "released"] as const;
export type DistributionEntryState = (typeof DISTRIBUTION_ENTRY_STATES)[number];

export interface DistributionEntry {
  kind: "party" | "unattributed";
  partyId: string | null;
  holderKey: string | null;
  payoutWallet: string | null;
  weight: bigint;
  /** This cycle's allocation. */
  allocated: bigint;
  /** Dust deferred to this party in earlier cycles and included here. */
  deferredIn: bigint;
  /** allocated + deferredIn. */
  amount: bigint;
  state: "payable" | "deferred" | "withheld" | "unattributed";
  /** Why a `deferred` entry is not payable; null for every other state. Auditable in the plan. */
  deferredReason: DistributionDeferredReason | null;
}

/** Why a party's entry is deferred rather than payable. */
export const DISTRIBUTION_DEFERRED_REASONS = ["zero_amount", "below_dust_threshold"] as const;
export type DistributionDeferredReason = (typeof DISTRIBUTION_DEFERRED_REASONS)[number];

/**
 * The state of a party entry, from its payout wallet, amount and the dust threshold. Fixed rule, shared by
 * the planner and by `distributionPlanProblems`: no wallet → withheld; amount 0 → deferred (zero_amount);
 * amount below the threshold → deferred (below_dust_threshold); otherwise payable.
 */
export function partyEntryState(payoutWallet: string | null, amount: bigint, dustThreshold: bigint): { state: "payable" | "deferred" | "withheld"; deferredReason: DistributionDeferredReason | null } {
  if (payoutWallet === null) return { state: "withheld", deferredReason: null };
  if (amount === 0n) return { state: "deferred", deferredReason: "zero_amount" };
  if (amount < dustThreshold) return { state: "deferred", deferredReason: "below_dust_threshold" };
  return { state: "payable", deferredReason: null };
}

export interface DistributionPlan {
  scheme: typeof DISTRIBUTION_PLAN_SCHEME;
  cycle: { id: string; version: number; simulation: boolean };
  policy: DistributionPolicy;
  netDistributableYield: bigint;
  ledgerIn: DistributionLedger;
  /** In canonical order: parties by id, then unattributed holdings by key (code-unit order). */
  entries: DistributionEntry[];
  totals: { payable: bigint; deferred: bigint; withheld: bigint; unattributed: bigint; remainderCarried: bigint };
  ledgerOut: DistributionLedger;
}
```

**Line rules** (`aggregateEvidence`; `AggregationErrorCode` at line 61: `invalid_line`, `unknown_evidence`,
`superseded_evidence`, `double_counted`, `currency_mismatch`, `rate_required`, `rate_not_allowed`,
`manifest_mismatch`):
- every line points at an item of the cycle's manifest;
- each evidence hash, and each source, backs at most one line;
- a foreign-currency line needs a recorded rational rate.

**Adapter mapping to the database's input lines:**
- `lineId` = `<sourceKind>:<sourceRef>`;
- `category` = the line's `kind`;
- side: `operating_expense` → `expense`, every other category → `revenue`;
- `amount`, the currency code, `completeness` and the evidence hash must all match (`dossier_mismatch`).

**Distribution entry states and stored rows:**

| Entry state | Stored row (`yield_allocations.kind`) | Leaf |
| --- | --- | --- |
| `payable` | `allocated` | yes, one per party |
| `withheld` | `withheld` | no |
| `unattributed` | `unattributed` | no |
| `deferred` (`zero_amount` or `below_dust_threshold`) | in the one `dust` row (its weight) | no |

The `dust` row's amount is `totals.dustCarriedForward + totals.remainderCarried`, so it includes dust carried in
for parties no longer holding.

`claimed`, `voided`, `expired`, `released` and `carried` are later transitions that this stage never performs.

**Ledgers** (G3):
- `ledgerIn` = what the plan took in, `ledgerOut` = what it carries out;
- canonical text is `canonicalCarryLedger` (`carry-ledger.ts` line 24), with deferred sorted by party id;
- the empty ledger is:
```json
{"carriedRemainder":"0","deferred":[]}
```

**Scenario plan totals and ledgers** (party D deferred below the dust threshold, so it is carried out):

```json
{
  "ledgerIn": {
    "carriedRemainder": "0",
    "deferred": []
  },
  "ledgerOut": {
    "carriedRemainder": "0",
    "deferred": [
      {
        "amount": "53550000",
        "partyId": "party-d"
      }
    ]
  },
  "totals": {
    "deferred": "53550000",
    "payable": "4284000000",
    "remainderCarried": "0",
    "unattributed": "214200000",
    "withheld": "803250000"
  }
}
```

**Scenario evidence lines:**

```json
[
  {
    "amount": "800000",
    "category": "gross_revenue",
    "completeness": "known",
    "currency": {
      "code": "USD",
      "exponent": 2
    },
    "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000001",
    "lineId": "rev-usd",
    "rate": null
  },
  {
    "amount": "400000",
    "category": "gross_revenue",
    "completeness": "known",
    "currency": {
      "code": "EUR",
      "exponent": 2
    },
    "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000002",
    "lineId": "rev-eur",
    "rate": {
      "den": "200",
      "num": "217",
      "observedAt": "2026-09-30T16:00:00Z",
      "source": "simulation-rate"
    }
  },
  {
    "amount": "34000",
    "category": "refund",
    "completeness": "known",
    "currency": {
      "code": "USD",
      "exponent": 2
    },
    "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000003",
    "lineId": "refund",
    "rate": null
  },
  {
    "amount": "300000",
    "category": "operating_expense",
    "completeness": "known",
    "currency": {
      "code": "USD",
      "exponent": 2
    },
    "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000004",
    "lineId": "cost-transport",
    "rate": null
  },
  {
    "amount": "200000",
    "category": "operating_expense",
    "completeness": "known",
    "currency": {
      "code": "USD",
      "exponent": 2
    },
    "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000005",
    "lineId": "cost-storage",
    "rate": null
  }
]
```

**Simulation distribution policy** (`SIMULATION_DISTRIBUTION_POLICY`, simulation only; D-9, D-14 pending):

```json
{
  "dustThreshold": "0",
  "id": "simulation-distribution-defaults",
  "missingPayoutWallet": "withhold",
  "remainder": "largest_remainder",
  "status": "simulation",
  "version": 1
}
```

## 5. Frozen cycle artifact and what is persisted at calculate
`packages/domain/src/yield/pipeline.ts` lines 90–111:

```ts
export interface CycleDistributionArtifact {
  scheme: typeof CYCLE_ARTIFACT_SCHEME;
  cycle: { id: string; version: number; simulation: boolean; assetClass: string };
  evidence: { manifestSha256: string; itemCount: number };
  /** The full verified snapshot the distribution used; every leaf carries its hash. */
  ownership: VerifiedOwnershipSnapshot;
  calculation: {
    artifactSha256: string;
    /** Accounting minor units. */
    netDistributableYield: bigint;
    loss: bigint;
    shortfall: bigint;
    /** The NDY in settlement base units, with the fraction dropped by the conversion. */
    settlementAmount: bigint;
    conversion: ConversionResult;
  };
  distribution: { planSha256: string; plan: DistributionPlan };
  /** Null when nothing is payable (e.g. a zero or loss cycle). */
  claimTree: { hasherId: string; policyId: string; root: string; size: number; leaves: CycleArtifactLeaf[] } | null;
  /** Settlement base units. inflow = settlementAmount + carried remainder + carried dust. */
  totals: { inflow: bigint; leaves: bigint; dustCarriedForward: bigint; withheld: bigint; unattributed: bigint; remainderCarried: bigint };
}
```
`packages/db/src/repositories/yield.ts` lines 471–499:

```ts
export interface YieldFrozenLeafRecord {
  leafIndex: number;
  partyId: string;
  payoutWallet: string;
  /** Hex of the 32 recipient bytes. */
  recipient: string;
  amount: bigint;
  /** Hex of the leaf bytes. */
  leafBytes: string;
  leafHash: string;
  /** Hex sibling hashes, nearest first. */
  path: string[];
}

export interface YieldFrozenArtifactRecord {
  scheme: string;
  /** The canonical artifact text; its SHA-256 is the set hash. */
  body: string;
  hasherId: string;
  leaves: readonly YieldFrozenLeafRecord[];
}

export interface YieldCarryRecord {
  /** The predecessor's approved artifact set (yield_carry_source), or null. */
  sourceSetId: string | null;
  /** Canonical carry ledgers (packages/domain yield/carry-ledger.ts) and their SHA-256. */
  ledgerIn: { body: string; sha256: string };
  ledgerOut: { body: string; sha256: string };
}
```

**Persisted at `calculate`** (simulation cycles only; all or nothing, in one transaction):

| Table | Holds | Integrity |
| --- | --- | --- |
| `yield_artifact_sets` | the hashes | `set_hash` = SHA-256 of the canonical artifact |
| `yield_frozen_artifacts` | that canonical text (0027) | its hash is checked by the database and must equal the set hash |
| `yield_claim_leaves` | every leaf with its RFC 9162 path | root = the set's root; amount = the party's `allocated` row; count = `leaf_count` |
| `yield_carry_ledgers` | carry-in and carry-out with their SHA-256 (0028) | chained to the predecessor (below) |

`calculate` cannot complete without the artifact, every leaf and the carry row: database triggers enforce it in
addition to the 0024 guard. When nothing is payable, the root is the RFC 9162 empty-tree hash, SHA-256 of the empty
string (`EMPTY_TREE_ROOT`).

**Refusals:**
- `artifact_missing`, `artifact_mismatch`, `not_calculating`;
- `carry_source_mismatch`, `carry_source_missing`, `carry_mismatch`, `carry_predecessor_open`,
  `carry_missing`;
- `real_gate`.

**Reads use storage only:** `GET …/artifact-sets/{setId}/leaves` and the holder's `GET
…/me/yield/cycles/{cycleId}/proof`. Each stored proof is re-verified against the set's root before it is served
(`proof_invalid`). `preview` persists nothing.

**Carry chain** (`yield_carry_source`, 0028):
- the predecessor is the approved set of the latest **published or closed simulation** cycle of the same tenant,
  business asset and chain asset that ends before this cycle starts (latest period end, then highest version);
- no predecessor: the carry-in is the empty ledger (`yield_carry_ledgers_genesis`);
- the carry-in must hash to the predecessor's carry-out;
- an open cycle in between refuses the calculation (`carry_predecessor_open`), so carry is consumed in order and
  never twice;
- corrections (a new version of the same period) consume the same predecessor; a superseded version drops out;
- rows are append-only.

## 6. Simulation dossier
`packages/domain/src/yield/simulation-dossier.ts` lines 28–52:

```ts
export interface SimulationDossier {
  scheme: typeof SIMULATION_DOSSIER_SCHEME;
  /** The asset class the cycle is calculated under (plan §1.1; real classes need D-20). */
  assetClass: string;
  /** Status `simulation`. Its hash (`yieldArtifactHash`) must equal the cycle's locked policy hash. */
  calculationPolicy: YieldCalculationPolicy;
  /** The single conversion from the accounting currency into settlement base units (D-3, D-4). */
  settlementRate: RationalRate;
  /** Status `simulation`. */
  distributionPolicy: DistributionPolicy;
  /** What the previous cycle carried; explicit, empty when nothing is carried. */
  distributionLedger: DistributionLedger;
  /** Accounting minor units. */
  lossCarriedForward: bigint;
  /** Accounting minor units. */
  approvedReserveReleases: bigint;
  /** Full metadata of every evidence item the cycle's input lines point at; nothing else. */
  evidence: EvidenceItem[];
  /** One line per locked input line (`lineId` = `<sourceKind>:<sourceRef>`), same amount, currency and evidence. */
  lines: EvidenceLine[];
  /** Simulation payout address (base58 or 64 hex) per party in the ownership input, or null (withheld). */
  payoutAddresses: Record<string, string | null>;
  /** When the ownership point (the window's end slot) is taken to be observed (RFC 3339 with offset). */
  ownershipObservedAt: string;
}
```

**Rules** (`parseSimulationDossier`, line 119; `SimulationDossierErrorCode` line 54: `invalid_dossier`,
`not_simulation`):
- exact keys; no defaults;
- policies must have status `simulation`;
- bigints are only the fields in `DOSSIER_BIGINT_KEYS` (line 82);
- stored as canonical text with its SHA-256 (0026: simulation draft cycles only, append-only; the latest revision
  at lock is the one calculated with).

**Engine refusals** (`yield-pipeline-engine.ts`):
- `simulation_only`;
- `dossier_missing`, `dossier_mismatch`, `dossier_incomplete`;
- `real_network_ownership`, `weight_exceeds_u64`;
- `carry_from_dossier_refused` (the dossier's `distributionLedger` must be empty: carry-in comes only from 0028),
  `carry_mismatch`;
- `calculation_refused` (any pipeline refusal, with its own code in the message).

The policy hash a cycle locks is `calculationPolicyHash` (= `yieldArtifactHash(policy)`).

**Full dossier** (`apps/api/src/test/yield-dossier.ts`):
```json
{
  "approvedReserveReleases": "0",
  "assetClass": "crop",
  "calculationPolicy": {
    "accountingCurrency": {
      "code": "USD",
      "exponent": 2
    },
    "allowEstimatedCosts": false,
    "conversionDateRule": "settlement_date",
    "entitlement": {
      "id": "simulation-entitlement",
      "sha256": "abababababababababababababababababababababababababababababababab",
      "version": "illustration"
    },
    "fee": {
      "alternative": "F3",
      "basisPoints": "1000",
      "maximum": null,
      "minimum": null
    },
    "formulaVersion": "yield-formula/1",
    "id": "simulation-policy",
    "lossCarryForward": {
      "enabled": true
    },
    "recognitionBasis": "cash",
    "reserves": {
      "maintenanceBasisPoints": "1000",
      "maintenanceCap": null,
      "riskBasisPoints": "500",
      "riskCap": null
    },
    "status": "simulation",
    "version": 1
  },
  "distributionLedger": {
    "carriedRemainder": "0",
    "deferred": []
  },
  "distributionPolicy": {
    "dustThreshold": "0",
    "id": "simulation-distribution-defaults",
    "missingPayoutWallet": "withhold",
    "remainder": "largest_remainder",
    "status": "simulation",
    "version": 1
  },
  "evidence": [
    {
      "byteSize": 10,
      "classification": "confidential",
      "contentSha256": "0000000000000000000000000000000000000000000000000000000000000001",
      "issuedAt": "2026-03-30T10:00:00+03:30",
      "mediaType": "application/pdf",
      "recordedAt": "2026-04-01T08:00:00Z",
      "recordedBy": "preparer-1",
      "retentionClassId": "simulation-retention",
      "sourceId": "INV-1",
      "supersedes": null,
      "timeZone": "Asia/Tehran",
      "type": "sales_invoice"
    },
    {
      "byteSize": 10,
      "classification": "confidential",
      "contentSha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "issuedAt": "2026-03-30T10:00:00+03:30",
      "mediaType": "application/pdf",
      "recordedAt": "2026-04-01T08:00:00Z",
      "recordedBy": "preparer-1",
      "retentionClassId": "simulation-retention",
      "sourceId": "EXP-1",
      "supersedes": null,
      "timeZone": "Asia/Tehran",
      "type": "sales_invoice"
    }
  ],
  "lines": [
    {
      "amount": "800000",
      "category": "gross_revenue",
      "completeness": "known",
      "currency": {
        "code": "USD",
        "exponent": 2
      },
      "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000001",
      "lineId": "invoice:INV-1",
      "rate": null
    },
    {
      "amount": "300000",
      "category": "operating_expense",
      "completeness": "known",
      "currency": {
        "code": "USD",
        "exponent": 2
      },
      "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "lineId": "invoice:EXP-1",
      "rate": null
    }
  ],
  "lossCarriedForward": "0",
  "ownershipObservedAt": "2026-03-31T23:59:59Z",
  "payoutAddresses": {
    "00000000-0000-4000-8000-0000000000aa": "0101010101010101010101010101010101010101010101010101010101010101",
    "00000000-0000-4000-8000-0000000000bb": null
  },
  "scheme": "metafarm-yield-simulation-dossier/1",
  "settlementRate": {
    "den": "1",
    "num": "1",
    "observedAt": "2026-03-31T16:00:00Z",
    "source": "simulation-peg"
  }
}
```

## 7. The Y5 weighted ownership input (the adapter's source)
`packages/domain/src/twin/holding-weights.ts` lines 184–199:

```ts
export interface WeightedOwnershipInput {
  scheme: typeof WEIGHTED_OWNERSHIP_SCHEME;
  model: typeof HOLDING_MODEL;
  asset: ChainAssetRef;
  window: HoldingWindow;
  simulation: boolean;
  provenance: OwnershipProvenance;
  /** SHA-256 of the canonical events used (slot ≤ endSlot, chain order, replays once). */
  eventsSha256: string;
  parties: WeightedPartyEntry[];
  unattributed: WeightedUnattributedEntry[];
  totalWeight: bigint;
  pointInTimeTotal: bigint;
  /** SHA-256 of the canonical committed content (everything above). */
  commitment: string;
}
```

**Rules** (`buildWeightedOwnershipInput`, line 251; codes `HOLDING_WEIGHT_ERROR_CODES`, line 38):
- window `(start, end]` of at most 2^32 slots (`MAX_SLOT_SPAN`);
- weight = Σ balance over the window's slots; total ≤ 2^128 − 1 (`WEIGHT_MAX`);
- fixture history never builds a real cycle's input (`fixture_in_real_cycle`);
- RPC history needs a verified identity of the asset's network (`unverified_source`);
- the window must end at or before the index cursor (`incomplete_history`);
- verified RPC precedence over fixture rows, and `ambiguous_provenance`, are enforced by the reader
  (`readVerifiedOwnershipHistory`).

## 8. Engine contract
`apps/api/src/lib/yield-engine.ts` lines 16–57:

```ts
export interface YieldCalculationRequest {
  cycle: YieldCycleRow;
  inputs: readonly YieldInputRow[];
  ownership: WeightedOwnershipInput;
  /** The cycle's simulation dossier (latest registered while in draft), or null when none was registered. */
  dossier: SimulationDossier | null;
  /** The SHA-256 of each input line's evidence (by input id), or null for a line without evidence. */
  evidenceSha256ByInput: Readonly<Record<string, string | null>>;
  /**
   * The carry-in, read from the platform (migration 0028): the predecessor's recorded carry-out, already checked
   * against its hash, or the empty ledger when the cycle has no predecessor. Never taken from the dossier.
   */
  carryIn: { sourceSetId: string | null; ledger: DistributionLedger; sha256: string };
}

/** An engine refusal with a stable code; nothing is stored. */
export class YieldEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "YieldEngineError";
  }
}

export interface YieldCalculationResult {
  calculationHash: string;
  allocationHash: string;
  evidenceBundleHash: string;
  merkleRoot: string;
  /** The hash attested to and approved (over the four hashes above). */
  setHash: string;
  allocations: YieldAllocationRecord[];
  /** Totals for display (decimal strings, accounting minor units); not stored. */
  totals: Record<string, string>;
  /** The frozen artifact (canonical text hashing to `setHash`) and its claim leaves, persisted at calculate. */
  frozen: YieldFrozenArtifactRecord;
  /** The canonical carry ledgers the calculation took in and carries out, with their SHA-256. */
  carry: { ledgerIn: { body: string; sha256: string }; ledgerOut: { body: string; sha256: string } };
}
```

`engineOutputProblems` refuses (502 `engine_output_invalid`):
- a recipient that is not in the ownership input;
- duplicates;
- negative amounts;
- more than one dust row;
- a leaf that does not pay its party's allocated amount;
- a result that ignored the platform's carry-in.

## 9. Unsigned simulation claim intents (Y13, migration 0029)

`packages/domain/src/yield/claim-intent.ts` (types `UnsignedClaimIntent`, `ClaimIntentBatch`; builder
`buildClaimIntentBatch`). Schemes `metafarm-yield-claim-intent/1` and `metafarm-yield-claim-intent-batch/1`, both at
`version: 1`.

```ts
export interface UnsignedClaimIntent {
  scheme: "metafarm-yield-claim-intent/1";
  version: 1;
  signed: false;            // never signed by the platform
  simulation: true;
  network: string;          // the artifact's snapshot network; simulation networks only
  cycleId: string;
  cycleVersion: number;
  setNumber: number;
  artifactSetHash: string;  // binds the intent to its frozen set (= the stored artifact's SHA-256)
  merkleRoot: string;
  treeSize: number;
  leafIndex: number;
  leafHash: string;
  leafBytes: string;        // hex of the stored leaf bytes
  proof: { hasherId: string; path: string[]; pathSha256: string };  // stored RFC 9162 path and its hash
  partyId: string;
  recipient: string;        // hex of the leaf's 32 recipient bytes
  payoutAddress: string;
  amount: bigint;           // settlement base units, u64 (decimal string in JSON)
  payoutMint: string;
  economicAssetId: string;
  createdAt: string;        // the stored artifact's time, so the batch is identical whenever it is rebuilt
}
```

A batch has the same header fields (`scheme`, `version`, `signed: false`, `simulation: true`, `network`, `cycleId`,
`cycleVersion`, `setNumber`, `artifactSetHash`, `merkleRoot`, `treeSize`, `createdAt`) and `intents`, ordered by leaf
index.

**Canonical form and hash:** `canonicalYieldArtifact(batch)` and its SHA-256, which is `batchSha256`. One stored set
gives the same batch byte for byte. `createdAt` is the frozen artifact's own `created_at`, not the request time.

**Minimal example** (one leaf; canonical keys sorted; shown indented):

```json
{
  "artifactSetHash": "<64 hex>", "createdAt": "2026-10-22T10:00:00.000Z", "cycleId": "<uuid>", "cycleVersion": 1,
  "intents": [{
    "amount": "2295000000", "artifactSetHash": "<64 hex>", "createdAt": "2026-10-22T10:00:00.000Z", "cycleId": "<uuid>",
    "cycleVersion": 1, "economicAssetId": "<base58 mint>", "leafBytes": "<466 hex>", "leafHash": "<64 hex>", "leafIndex": 0,
    "merkleRoot": "<64 hex>", "network": "simulation", "partyId": "<uuid>", "payoutAddress": "<64 hex>",
    "payoutMint": "So11111111111111111111111111111111111111112",
    "proof": { "hasherId": "sha256-rfc9162", "path": [], "pathSha256": "<64 hex>" },
    "recipient": "<64 hex>", "scheme": "metafarm-yield-claim-intent/1", "setNumber": 1, "signed": false,
    "simulation": true, "treeSize": 1, "version": 1
  }],
  "merkleRoot": "<64 hex>", "network": "simulation", "scheme": "metafarm-yield-claim-intent-batch/1", "setNumber": 1,
  "signed": false, "simulation": true, "treeSize": 1, "version": 1
}
```

**Generation rules.** `POST …/cycles/{cycleId}/claim-intents` (`yield:approve`; `apps/api/src/routes/yield.ts`,
`buildIntents`).

The switches: off unless `YIELD_WORKFLOW_ENABLED` and `YIELD_CLAIM_INTENTS_ENABLED` are both set (404 otherwise), and
the second is refused by configuration in staging and production.

The service reads stored data only and recomputes nothing:
1. The cycle must be simulation (`real_gate`) and published (`invalid_state`; disputed gives `payouts_paused`).
2. The approved set must carry the cycle's hash (`artifact_missing`).
3. The frozen artifact must be stored, and its body must hash to the set hash (`artifact_mismatch`).
4. The artifact names this cycle and version as simulation, and its snapshot network is a simulation network
   (`non_simulation_network`).
5. Its claim tree is the set's (root, size) and has leaves (`nothing_payable`).
6. Exactly `leaf_count` leaves must be stored (`artifact_mismatch`).
7. Every stored proof must verify against the set root (`proof_invalid`).
8. Every stored leaf must equal the artifact's, and decode to its recorded amount, recipient, payout mint, economic
   asset, cycle id, version and index (`leaf_mismatch`).

One batch per set (`intents_exist`). An idempotent retry replays the stored answer. Refusals store nothing.

**Storage (0029).** `yield_claim_intent_batches` holds the canonical body and its SHA-256, checked by the database.
The table is unique per `artifact_set_id` and per `(cycle_id, set_number, batch_sha256)`.

The guard trigger allows inserts only for:
- a published simulation cycle with its approved set;
- a body that names that set's hash and number and the cycle;
- a body that is unsigned and simulation;
- a body with one intent per stored leaf.

The table is append-only with RLS. `GET …/claim-intents` re-hashes the stored body on read (`artifact_mismatch`).

**Not here:** signatures, submission, payout rails, expiry (D-25, D-27), compliance screening (D-15), and holder
disclosures (D-39).

## Cross-references

- **Plan:** `docs/delivery/real-yield-distribution-plan.md` (revision 4, plan branch), §4, §6.2, §7.2, §11.1.
- **Stage map and switches:** `docs/real-yield-implementation.md`.
- **Decisions and notes:** decision records and security notes on the plan branch
  (`decision-adoptions-2026-10-22.md`, `y5-y7-y12-security-notes.md`).
- **Tests pinning these shapes:**
  - `packages/db/src/line-join-sync.test.ts`;
  - `apps/api/src/yield-pipeline-engine.test.ts`;
  - `apps/api/src/line-join-provenance.test.ts`;
  - `apps/api/src/yield-pipeline.int.test.ts`;
  - `packages/domain/src/yield/pipeline.test.ts`.
