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

/** Records events; an event already recorded is skipped. Returns how many rows were added. */
export async function insertOwnershipEvents(tx: SystemTx, events: readonly OwnershipEvent[], source: OwnershipIndexSource): Promise<number> {
  if (events.length === 0) return 0;
  const col = <T>(f: (e: OwnershipEvent) => T) => events.map(f);
  const r = await tx.query(
    `INSERT INTO chain_ownership_events (network, rail, asset_id, kind, from_address, to_address, amount, slot, tx_index, ix_index, signature, source)
     SELECT x.*, $12 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::bigint[], $9::int[], $10::int[], $11::text[])
       AS x(network, rail, asset_id, kind, from_address, to_address, amount, slot, tx_index, ix_index, signature)
     ON CONFLICT DO NOTHING`,
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
    ],
  );
  return r.rowCount ?? 0;
}

/** Moves an asset's cursor forward (never back). Returns the slot it is indexed through afterwards. */
export async function advanceOwnershipCursor(tx: SystemTx, asset: ChainAssetRef, throughSlot: bigint, source: OwnershipIndexSource): Promise<bigint> {
  const r = await tx.query<{ indexed_through_slot: string }>(
    `INSERT INTO chain_ownership_cursors (network, rail, asset_id, indexed_through_slot, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (network, rail, asset_id) DO UPDATE
       SET indexed_through_slot = GREATEST(chain_ownership_cursors.indexed_through_slot, EXCLUDED.indexed_through_slot),
           source = EXCLUDED.source, updated_at = now()
     RETURNING indexed_through_slot`,
    [asset.network, asset.rail, asset.id, throughSlot.toString(), source],
  );
  return BigInt(r.rows[0]!.indexed_through_slot);
}

export async function ownershipCursorOf(tx: SystemTx, asset: ChainAssetRef): Promise<bigint | null> {
  const r = await tx.query<{ s: string }>(
    `SELECT indexed_through_slot::text AS s FROM chain_ownership_cursors WHERE network = $1 AND rail = $2 AND asset_id = $3`,
    [asset.network, asset.rail, asset.id],
  );
  return r.rows[0] ? BigInt(r.rows[0].s) : null;
}

/**
 * One asset's index, read as the application role in a read-only transaction. Null when the asset has
 * no cursor, that is, it is not indexed. Events after the cursor are excluded, so a reading never mixes
 * a newer partial scan into an older complete one.
 */
export async function readOwnershipIndex(pool: Pool, asset: ChainAssetRef): Promise<IndexedOwnership | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE metafarm_app");
    const c = await client.query<{ s: string }>(
      `SELECT indexed_through_slot::text AS s FROM chain_ownership_cursors WHERE network = $1 AND rail = $2 AND asset_id = $3`,
      [asset.network, asset.rail, asset.id],
    );
    if (!c.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const through = c.rows[0].s;
    const e = await client.query<EventRow>(
      `SELECT network, rail, asset_id, kind, from_address, to_address, amount::text AS amount, slot::text AS slot, tx_index, ix_index, signature
         FROM chain_ownership_events
        WHERE network = $1 AND rail = $2 AND asset_id = $3 AND slot <= $4
        ORDER BY slot, tx_index, ix_index, signature, id`,
      [asset.network, asset.rail, asset.id, through],
    );
    await client.query("COMMIT");
    return { events: e.rows.map(toEvent), indexedThroughSlot: BigInt(through) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
