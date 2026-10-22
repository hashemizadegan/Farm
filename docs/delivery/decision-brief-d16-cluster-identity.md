# Decision brief: D-16, cluster identity for ownership sources (unblocks Y0)

**Status: OPEN — FOR REVIEW ONLY (NO APPROVALS).** Prepared 2026-10-22 against plan revision 4 (`f914af4`).
The plan defines D-16 as "Cluster identifier, storage and binding (provenance is a safeguard)" (§12, D-16; §4.2;
§7.2 `ownership_source_identities`).

## Problem

Allocations must come only from ownership events read from the **intended Solana cluster**. Today the J7 index
(#50–#52) cannot prove that:
- `chain_ownership_events` and `chain_ownership_cursors` (migration 0020) record only a `network` **label** and a
  `source`, with no verified identity.
- The ownership-index job does not check the cluster. `getGenesisHash` verification already exists
  (`packages/chain/src/solana/cluster.ts`: `SOLANA_GENESIS_HASHES`, `ClusterVerificationError`), but only the RWA
  start-up preflight uses it, and it records nothing.

So an RPC endpoint pointed at the wrong cluster could fill the index, and nothing in the data would show it.
Snapshots, and the 32-byte cluster-identity field already present in every claim leaf (§6.2), have no verified
value to carry.

## Trade-offs

- **Provenance vs simplicity:** recording *how and when* a source was verified costs a table and a foreign key.
  Without it, a snapshot cannot be traced to a verified source.
- **Check frequency vs RPC cost:** verifying once at start-up misses endpoint changes while running. Verifying
  every batch adds one cheap `getGenesisHash` call per batch.
- **Identifier strength:** a cluster name or RPC URL is configuration, not proof. The genesis hash is
  cluster-unique and immutable.

## Options

| | A. Identity table, referenced by cursors and events (recommended) | B. Genesis-hash columns on cursors and events | C. Configuration-asserted identity |
| --- | --- | --- | --- |
| Identifier | genesis hash | genesis hash | network label + configured URL |
| Storage | `ownership_source_identities` (network, genesis hash, endpoint fingerprint as scheme + host only, `verified_at`, verifier); `identity_id` foreign key on cursors and events, **NOT NULL when `source = 'rpc'`** | a `cluster_genesis_hash` column on every cursor and event row | none |
| When verified | at source registration **and before every indexing batch**; mismatch → no writes, cursor not advanced | before every batch | at start-up only (today's preflight) |
| Provenance | full: who, when, which endpoint host | the hash only; when and how are lost | none |
| Fails closed in the database | yes: unbound `rpc` rows are refused by a constraint | partly: a NULL or CHECK on the hash | no |
| Operational cost | one small table, one migration, one RPC call per batch | one migration; the hash is duplicated on every row | none |
| Feeds the leaf cluster identity (§6.2) | yes (32 bytes from the stored hash) | yes | no verified value |

## Recommendation: Option A

**Option A** is the only option that fails closed at every layer:
- the job refuses a mismatched cluster before writing;
- the database refuses `rpc` rows without a verified identity;
- the reader serves only bound rows.

It is deterministic: the identity is an immutable genesis hash, and the same events give the same snapshot and
leaves. It is also the least operational work that keeps provenance, because it reuses the existing
`getGenesisHash` check.

Option B saves a table but discards provenance, which the plan names as a safeguard. Retrofitting provenance
later would mean migrating every row. Option C records nothing and cannot be audited.

**To approve, the owner confirms:**
1. the identifier is the genesis hash;
2. storage is a separate identity table, with `identity_id` NOT NULL for `rpc` rows;
3. verification runs at registration and before every batch;
4. the endpoint fingerprint is scheme + host only, never credentials, path or query;
5. an endpoint change creates a new identity row, and existing rows keep theirs;
6. `fixture` rows carry no identity and stay simulation-only (with D-17).

## What D-16 unblocks: Y0

Per plan §11.1, Y0 is a new PR on the J7 line (base #59; #50–#52 not modified). It touches `packages/chain`,
`packages/db` and `apps/worker`. **It does not stack on the yield stack (#75–#84), which is `packages/domain`
only.** With D-16 approved, Y0 can be written and tested immediately:

- **Migration** (next free number after #57's 0022, with a down migration):
  - the `ownership_source_identities` table;
  - an `identity_id` foreign key on `chain_ownership_events` and `chain_ownership_cursors`;
  - a constraint making it NOT NULL for `source = 'rpc'`.
- **Chain:** `verifySourceIdentity(rpc, network)` built on the existing `cluster.ts`. It returns or creates the
  identity row and throws `ClusterVerificationError` on a mismatch.
- **Worker:** the ownership-index job verifies before each batch. On a mismatch it writes nothing, leaves the
  cursor unchanged and logs the expected and actual hashes.
- **Reader:** non-fixture reads require a verified identity.
- **Tests (stubbed RPC, as the plan requires):** mismatch, missing identity, configuration mismatch, provenance
  recorded, unverified sources refused.

**Still gated after Y0 is built:** using it live needs the deploy hold lifted and J7 enabled by the owner. Neither
is part of this decision.

**How this connects to the yield stack:** after Y0, Y5 (also needing D-12 and D-17) can implement the
`IOwnershipSourceAdapter` from #76 over J7 events bound to a verified identity. The genesis hash would become each
leaf's cluster identity. Until then the yield pipeline keeps the supplied, simulation-only snapshot, and real
networks stay refused.
