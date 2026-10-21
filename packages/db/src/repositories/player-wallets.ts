/**
 * Player wallets (migration 0022, J8): Solana wallets linked to a platform user after a signed,
 * one-time challenge. Per user, not per tenant; never granted to the tenant role. Independent of RWA
 * party wallets (`party_wallets`): nothing here reads or writes them.
 */
import type { Pool } from "../pool";

export interface PlayerWalletRow {
  address: string;
  chain: "solana";
  linked_at: Date;
}

export class PlayerWalletTakenError extends Error {
  constructor() {
    super("this wallet is linked to another account");
    this.name = "PlayerWalletTakenError";
  }
}

/** Issues a challenge, replacing any earlier one for this user and address, and drops expired ones. */
export async function storePlayerWalletChallenge(pool: Pool, c: { userId: string; address: string; nonce: string; message: string; expiresAt: Date }): Promise<void> {
  await pool.query(`DELETE FROM player_wallet_challenges WHERE expires_at < now() OR (user_id = $1 AND address = $2)`, [c.userId, c.address]);
  await pool.query(
    `INSERT INTO player_wallet_challenges (nonce, user_id, chain, address, message, expires_at) VALUES ($1, $2, 'solana', $3, $4, $5)`,
    [c.nonce, c.userId, c.address, c.message, c.expiresAt],
  );
}

/**
 * Takes the user's live challenge for this address, once: it is deleted whether or not the signature
 * that follows is valid, so a challenge can never be tried twice or raced. Null if there is none.
 */
export async function takePlayerWalletChallenge(pool: Pool, userId: string, address: string, now: Date): Promise<{ message: string } | null> {
  const r = await pool.query<{ message: string; expires_at: Date }>(
    `DELETE FROM player_wallet_challenges WHERE user_id = $1 AND address = $2 RETURNING message, expires_at`,
    [userId, address],
  );
  const row = r.rows[0];
  if (!row || row.expires_at.getTime() <= now.getTime()) return null;
  return { message: row.message };
}

/** Links the wallet to the user. Linking it again to the same user changes nothing. */
export async function linkPlayerWallet(pool: Pool, userId: string, address: string): Promise<{ row: PlayerWalletRow; created: boolean }> {
  const inserted = await pool.query<PlayerWalletRow>(
    `INSERT INTO player_wallets (user_id, chain, address) VALUES ($1, 'solana', $2)
     ON CONFLICT (chain, address) DO NOTHING
     RETURNING address, chain, linked_at`,
    [userId, address],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
  const existing = await pool.query<PlayerWalletRow & { user_id: string }>(
    `SELECT user_id, address, chain, linked_at FROM player_wallets WHERE chain = 'solana' AND address = $1`,
    [address],
  );
  const row = existing.rows[0];
  if (!row || row.user_id !== userId) throw new PlayerWalletTakenError();
  return { row: { address: row.address, chain: row.chain, linked_at: row.linked_at }, created: false };
}

export async function listPlayerWallets(pool: Pool, userId: string): Promise<PlayerWalletRow[]> {
  return (await pool.query<PlayerWalletRow>(`SELECT address, chain, linked_at FROM player_wallets WHERE user_id = $1 ORDER BY linked_at, address`, [userId])).rows;
}

/** Unlinks the user's own wallet. False if the user has no such wallet. */
export async function unlinkPlayerWallet(pool: Pool, userId: string, address: string): Promise<boolean> {
  return ((await pool.query(`DELETE FROM player_wallets WHERE user_id = $1 AND chain = 'solana' AND address = $2`, [userId, address])).rowCount ?? 0) > 0;
}
