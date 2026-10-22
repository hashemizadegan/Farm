/**
 * Deterministic chain-event fixtures in the canonical relay form (`metafarm-relay`): valid events and one broken
 * variant per rule. Shared by the domain, API and integration tests. Addresses are made up (valid base58 only).
 */
export const FIXTURE_MINT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
export const FIXTURE_FROM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const FIXTURE_TO = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const FIXTURE_SIGNATURE = "5".repeat(64) + "Kx".repeat(12);

export const ownershipChangeData = (over: Record<string, unknown> = {}) => ({
  kind: "ownership_change",
  network: "solana-devnet",
  rail: "SOLANA_TOKEN_2022",
  assetId: FIXTURE_MINT,
  transaction: { signature: FIXTURE_SIGNATURE, slot: "310000900", ixIndex: 2 },
  ownership: { change: "transfer", from: FIXTURE_FROM, to: FIXTURE_TO, amount: "18446744073709551615" },
  metadata: null,
  finality: "finalized",
  providerTimestamp: "2026-10-22T19:00:00.000Z",
  ...over,
});

export const metadataUpdateData = (over: Record<string, unknown> = {}) => ({
  kind: "metadata_update",
  network: "solana-devnet",
  rail: "SOLANA_BUBBLEGUM_CNFT",
  assetId: FIXTURE_MINT,
  transaction: { signature: FIXTURE_SIGNATURE, slot: "310000901", ixIndex: 0 },
  ownership: null,
  metadata: { uri: "https://example.com/meta/1.json", contentSha256: "ab".repeat(32) },
  finality: "confirmed",
  providerTimestamp: "2026-10-22T19:00:01+03:30",
  ...over,
});

export const relayBody = (id: string, data: Record<string, unknown>) => ({ id, type: `chain.${String(data.kind)}`, data });
