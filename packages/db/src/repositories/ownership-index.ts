/**
 * Ownership index (migration 0020): finalized ownership events of Solana assets and how far each asset
 * has been indexed. Public chain data, not tenant-scoped. Holdings are never stored; readers rebuild
 * them from the events with the domain's rebuildOwnership.
 *
 * Writes need the system role (the indexer job); reads run as the application role, which may only
 * SELECT these tables.
 */
import type { ChainAssetRef, Network, OwnershipEvent, OwnershipEventKind, Rail } from "@metafarm/domain";
import type { Pool } from "../pool";
import type { SystemTx } from "../tenant";

export type OwnershipIndexSource = "fixture" | "rpc";

/**
 * A verified cluster identity (migration 0023, Y0): the network, the genesis hash the endpoint returned, and
 * the endpoint as scheme and host only. Never credentials, paths or query strings.
 */
export interface OwnershipSourceIdentityInput {
  network: Network;
  genesisHash: string;
  endpointScheme: "https" | "http";
  endpointHost: string;
  /** Who verified it, e.g. "worker:ownership-index". */
  verifiedBy: string;
}

export interface OwnershipSourceIdentity extends OwnershipSourceIdentityInput {
  id: bigint;
  verifiedAt: Date;
  lastVerifiedAt: Date;
}

/**
 * Records a verified identity, or, if the same (network, genesis hash, scheme, host) is already recorded,
 * marks it verified again (last_verified_at) and returns it. The first verification time and verifier are
 * kept. The database refuses a genesis hash that is not the network's, and a host with path or credentials.
 */
export async function registerOwnershipSourceIdentity(tx: SystemTx, i: OwnershipSourceIdentityInput): Promise<OwnershipSourceIdentity> {
  const r = await tx.query<{ id: string; network: Network; genesis_hash: string; endpoint_scheme: "https" | "http"; endpoint_host: string; verified_by: string; verified_at: Date; last_verified_at: Date }>(
    `INSERT INTO ownership_source_identities (network, genesis_hash, endpoint_scheme, endpoint_host, verified_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (network, genesis_hash, endpoint_scheme, endpoint_host) DO UPDATE SET last_verified_at = now()
     RETURNING id::text, network, genesis_hash, endpoint_scheme, endpoint_host, verified_by, verified_at, last_verified_at`,
    [i.network, i.genesisHash, i.endpointScheme, i.endpointHost, i.verifiedBy],
  );
  const x = r.rows[0]!;
  return { id: BigInt(x.id), network: x.network, genesisHash: x.genesis_hash, endpointScheme: x.endpoint_scheme, endpointHost: x.endpoint_host, verifiedBy: x.verified_by, verifiedAt: x.verified_at, lastVerifiedAt: x.last_verified_at };
}

export interface IndexedOwnership {
  events: OwnershipEvent[];
  /** Every finalized event of the asset up to and including this slot is in `events`. */
  indexedThroughSlot: bigint;
}

interface EventRow {
  network: Network;
  rail: Rail;
  asset_id: string;
  kind: OwnershipEventKind;
  from_address: string | null;
  to_address: string | null;
  amount: string;
  slot: string;
  tx_index: number;
  ix_index: number;
  signature: string;
}

const toEvent = (r: EventRow): OwnershipEvent => ({
  asset: { network: r.network, rail: r.rail, id: r.asset_id },
  kind: r.kind,
  from: r.from_address,
  to: r.to_address,
  amount: BigInt(r.amount),
  slot: BigInt(r.slot),
  txIndex: r.tx_index,
  ixIndex: r.ix_index,
  signature: r.signature,
});

/**
 * Records events; an event already recorded is skipped. Returns how many rows were added. RPC events need
 * the id of the cluster identity verified before this batch (the database refuses them otherwise); fixture
 * events take none.
 *
 * Rows written before migration 0023 (RPC, no identity) are never served. When a verified batch re-observes
 * exactly such an event (the same row under the events' unique key), the existing row is bound to the
 * verified identity instead of being skipped, so a re-index from a verified source restores it. Nothing else
 * is ever updated: rows already bound, and fixture rows, are left as they are. Bound rows are not counted
 * as added.
 */
export async function insertOwnershipEvents(tx: SystemTx, events: readonly OwnershipEvent[], source: OwnershipIndexSource, sourceIdentityId: bigint | null = null): Promise<number> {
  if (events.length === 0) return 0;
  const col = <T>(f: (e: OwnershipEvent) => T) => events.map(f);
  const r = await tx.query(
    `INSERT INTO chain_ownership_events (network, rail, asset_id, kind, from_address, to_address, amount, slot, tx_index, ix_index, signature, source, source_identity_id)
     SELECT x.*, $12, $13::bigint FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::bigint[], $9::int[], $10::int[], $11::text[])
       AS x(network, rail, asset_id, kind, from_address, to_address, amount, slot, tx_index, ix_index, signature)
     ON CONFLICT (network, signature, ix_index, rail, asset_id, kind, COALESCE(from_address, ''), COALESCE(to_address, ''), amount, slot, tx_index)
     DO UPDATE SET source_identity_id = EXCLUDED.source_identity_id
       WHERE chain_ownership_events.source = 'rpc' AND chain_ownership_events.source_identity_id IS NULL
         AND EXCLUDED.source = 'rpc' AND EXCLUDED.source_identity_id IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      col((e) => e.asset.network),
      col((e) => e.asset.rail),
      col((e) => e.asset.id),
      col((e) => e.kind),
      col((e) => e.from),
      col((e) => e.to),
      col((e) => e.amount.toString()),
      col((e) => e.slot.toString()),
      col((e) => e.txIndex),
      col((e) => e.ixIndex),
      col((e) => e.signature),
      source,
      sourceIdentityId === null ? null : sourceIdentityId.toString(),
    ],
  );
  // Returned rows are inserted (xmax = 0) or bound pre-0023 rows; only the former were added.
  return (r.rows as { inserted: boolean }[]).filter((x) => x.inserted).length;
}

/**
 * Moves an asset's cursor forward (never back). Returns the slot it is indexed through afterwards. An RPC
 * cursor records the cluster identity verified before the batch that moved it.
 *
 * Provenance rules (D-17, F2: verified RPC takes precedence):
 * - a cursor written before migration 0023 (RPC, no identity) is not trusted: its slot is replaced;
 * - a cursor of the other source is not trusted either: switching source restarts the cursor (slot replaced);
 * - a fixture batch can never move or demote a verified RPC cursor: refused with OwnershipProvenanceError.
 */
export async function advanceOwnershipCursor(tx: SystemTx, asset: ChainAssetRef, throughSlot: bigint, source: OwnershipIndexSource, sourceIdentityId: bigint | null = null): Promise<bigint> {
  const r = await tx.query<{ indexed_through_slot: string }>(
    `INSERT INTO chain_ownership_cursors (network, rail, asset_id, indexed_through_slot, source, source_identity_id)
     VALUES ($1, $2, $3, $4, $5, $6::bigint)
     ON CONFLICT (network, rail, asset_id) DO UPDATE
       SET indexed_through_slot = CASE
             WHEN chain_ownership_cursors.source = 'rpc' AND chain_ownership_cursors.source_identity_id IS NULL THEN EXCLUDED.indexed_through_slot
             WHEN chain_ownership_cursors.source <> EXCLUDED.source THEN EXCLUDED.indexed_through_slot
             ELSE GREATEST(chain_ownership_cursors.indexed_through_slot, EXCLUDED.indexed_through_slot)
           END,
           source = EXCLUDED.source, source_identity_id = EXCLUDED.source_identity_id, updated_at = now()
       WHERE NOT (chain_ownership_cursors.source = 'rpc' AND chain_ownership_cursors.source_identity_id IS NOT NULL AND EXCLUDED.source = 'fixture')
     RETURNING indexed_through_slot`,
    [asset.network, asset.rail, asset.id, throughSlot.toString(), source, sourceIdentityId === null ? null : sourceIdentityId.toString()],
  );
  if (!r.rows[0]) throw new OwnershipProvenanceError("fixture_after_verified_rpc", `a fixture batch cannot move the verified RPC cursor of ${asset.id}`);
  return BigInt(r.rows[0].indexed_through_slot);
}

/** The provenance of an asset's cursor: which source wrote it and whether it is bound to a verified identity. */
export interface OwnershipCursorState {
  source: OwnershipIndexSource;
  /** True for an RPC cursor bound to a verified cluster identity (Y0). */
  verified: boolean;
  sourceIdentityId: bigint | null;
  indexedThroughSlot: bigint;
}

export async function ownershipCursorState(tx: SystemTx, asset: ChainAssetRef): Promise<OwnershipCursorState | null> {
  const r = await tx.query<{ source: OwnershipIndexSource; id: string | null; s: string }>(
    `SELECT source, source_identity_id::text AS id, indexed_through_slot::text AS s FROM chain_ownership_cursors WHERE network = $1 AND rail = $2 AND asset_id = $3`,
    [asset.network, asset.rail, asset.id],
  );
  const x = r.rows[0];
  if (!x) return null;
  return { source: x.source, verified: x.source === "rpc" && x.id !== null, sourceIdentityId: x.id === null ? null : BigInt(x.id), indexedThroughSlot: BigInt(x.s) };
}

/**
 * The slot an asset is indexed through, for an indexer of the given source. Only a cursor of that source
 * counts, and for RPC only one bound to a verified identity: a cursor written before migration 0023 (RPC, no
 * identity) or by the other source counts as none, so the asset is re-indexed from the start.
 */
export async function ownershipCursorOf(tx: SystemTx, asset: ChainAssetRef, source: OwnershipIndexSource = "rpc"): Promise<bigint | null> {
  const state = await ownershipCursorState(tx, asset);
  if (!state || state.source !== source) return null;
  if (source === "rpc" && !state.verified) return null;
  return state.indexedThroughSlot;
}

export const OWNERSHIP_PROVENANCE_ERROR_CODES = ["ambiguous_provenance", "fixture_after_verified_rpc"] as const;
export type OwnershipProvenanceErrorCode = (typeof OWNERSHIP_PROVENANCE_ERROR_CODES)[number];

/** Ownership provenance that cannot be served or written safely. Stable codes. */
export class OwnershipProvenanceError extends Error {
  constructor(
    readonly code: OwnershipProvenanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipProvenanceError";
  }
}

/** An asset's served history and where it came from. */
export interface VerifiedOwnershipHistory {
  events: OwnershipEvent[];
  indexedThroughSlot: bigint;
  sourceKind: OwnershipIndexSource;
  /** The verified cluster identity of an RPC history (Y0); null for fixture history. */
  sourceIdentity: { id: string; network: Network; genesisHash: string } | null;
}

/**
 * One asset's history, read as the application role in a read-only transaction, under the provenance rules
 * (D-17; F2 resolved as "verified RPC takes precedence"):
 * - no cursor, or an RPC cursor without a verified identity (written before 0023): not indexed (null);
 * - a verified RPC cursor: only RPC events bound to a verified identity are served; fixture rows for the same
 *   asset are kept for audit but never served;
 * - a fixture cursor: fixture events only (simulation, tests, demonstrations), unless verified RPC events exist
 *   for the asset, which makes the provenance ambiguous: refused with OwnershipProvenanceError.
 * Events after the cursor are excluded, so a reading never mixes a newer partial scan into an older complete one.
 */
export async function readVerifiedOwnershipHistory(pool: Pool, asset: ChainAssetRef): Promise<VerifiedOwnershipHistory | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE metafarm_app");
    const c = await client.query<{ s: string; source: OwnershipIndexSource; id: string | null; network: Network | null; genesis_hash: string | null }>(
      `SELECT c.indexed_through_slot::text AS s, c.source, c.source_identity_id::text AS id, i.network, i.genesis_hash
         FROM chain_ownership_cursors c LEFT JOIN ownership_source_identities i ON i.id = c.source_identity_id
        WHERE c.network = $1 AND c.rail = $2 AND c.asset_id = $3`,
      [asset.network, asset.rail, asset.id],
    );
    const cursor = c.rows[0];
    if (!cursor || (cursor.source === "rpc" && cursor.id === null)) {
      await client.query("COMMIT");
      return null;
    }
    if (cursor.source === "fixture") {
      const v = await client.query(
        `SELECT 1 FROM chain_ownership_events WHERE network = $1 AND rail = $2 AND asset_id = $3 AND source = 'rpc' AND source_identity_id IS NOT NULL LIMIT 1`,
        [asset.network, asset.rail, asset.id],
      );
      if (v.rowCount) throw new OwnershipProvenanceError("ambiguous_provenance", `${asset.id} has a fixture cursor but verified RPC events`);
    }
    const filter = cursor.source === "rpc" ? `source = 'rpc' AND source_identity_id IS NOT NULL` : `source = 'fixture'`;
    const e = await client.query<EventRow>(
      `SELECT network, rail, asset_id, kind, from_address, to_address, amount::text AS amount, slot::text AS slot, tx_index, ix_index, signature
         FROM chain_ownership_events
        WHERE network = $1 AND rail = $2 AND asset_id = $3 AND slot <= $4 AND ${filter}
        ORDER BY slot, tx_index, ix_index, signature, id`,
      [asset.network, asset.rail, asset.id, cursor.s],
    );
    await client.query("COMMIT");
    return {
      events: e.rows.map(toEvent),
      indexedThroughSlot: BigInt(cursor.s),
      sourceKind: cursor.source,
      sourceIdentity: cursor.source === "rpc" ? { id: cursor.id!, network: cursor.network!, genesisHash: cursor.genesis_hash! } : null,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One asset's index for the twin reader: the served events and the slot they are complete through, under the
 * same provenance rules as readVerifiedOwnershipHistory (null when not indexed; ambiguous provenance throws,
 * which the API shows as `not_indexed` / `reader_unavailable`).
 */
export async function readOwnershipIndex(pool: Pool, asset: ChainAssetRef): Promise<IndexedOwnership | null> {
  const h = await readVerifiedOwnershipHistory(pool, asset);
  return h ? { events: h.events, indexedThroughSlot: h.indexedThroughSlot } : null;
}

/**
 * The Solana assets the platform has chain identities for, across all workspaces (system read: the
 * index is public data; only the asset identifiers leave this query).
 */
export async function ownershipIndexTargets(tx: SystemTx, limit = 5_000): Promise<ChainAssetRef[]> {
  const r = await tx.query<{ network: Network; rail: Rail; id: string }>(
    `SELECT DISTINCT network, rail, COALESCE(mint_address, das_asset_id) AS id
       FROM asset_representations
      WHERE rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT') AND COALESCE(mint_address, das_asset_id) IS NOT NULL
      ORDER BY 1, 2, 3
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ network: x.network, rail: x.rail, id: x.id }));
}

/**
 * The Merkle tree the platform recorded for a compressed asset (system read). Null when none is
 * recorded, or when representations disagree, so a source never reads the wrong tree's history.
 */
export async function bubblegumTreeOf(tx: SystemTx, network: Network, assetId: string): Promise<string | null> {
  const r = await tx.query<{ address: string }>(
    `SELECT DISTINCT t.address
       FROM asset_representations r JOIN merkle_trees t ON t.id = r.tree_id
      WHERE r.rail = 'SOLANA_BUBBLEGUM_CNFT' AND r.network = $1 AND r.das_asset_id = $2 AND t.address IS NOT NULL`,
    [network, assetId],
  );
  return r.rows.length === 1 ? r.rows[0]!.address : null;
}
