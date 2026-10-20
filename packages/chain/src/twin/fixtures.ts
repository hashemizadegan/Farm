/**
 * Made-up devnet-shaped ownership history for tests, local development and the client starter's
 * sample payloads. The addresses are base58 strings of repeated bytes: they are not real accounts.
 */
import type { ChainAssetRef, OwnershipEvent } from "@metafarm/domain";
import { base58Encode } from "../solana/base58";

const addr = (byte: number) => base58Encode(new Uint8Array(32).fill(byte));

export const FIXTURE_WALLETS = { custodian: addr(11), buyer: addr(12), investor: addr(13) } as const;
export const FIXTURE_ASSETS = {
  parcelLeaf: { network: "solana-devnet", rail: "SOLANA_BUBBLEGUM_CNFT", id: addr(21) },
  shareMint: { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: addr(22) },
} as const satisfies Record<string, ChainAssetRef>;

const sig = (n: number) => base58Encode(new Uint8Array(64).fill(n));

export const FIXTURE_EVENTS: readonly OwnershipEvent[] = [
  { asset: FIXTURE_ASSETS.parcelLeaf, kind: "mint", from: null, to: FIXTURE_WALLETS.custodian, amount: 1n, slot: 310_000_100n, txIndex: 4, ixIndex: 1, signature: sig(31) },
  { asset: FIXTURE_ASSETS.shareMint, kind: "mint", from: null, to: FIXTURE_WALLETS.custodian, amount: 1_000_000n, slot: 310_000_200n, txIndex: 2, ixIndex: 0, signature: sig(32) },
  { asset: FIXTURE_ASSETS.shareMint, kind: "transfer", from: FIXTURE_WALLETS.custodian, to: FIXTURE_WALLETS.investor, amount: 250_000n, slot: 310_000_900n, txIndex: 7, ixIndex: 0, signature: sig(33) },
  { asset: FIXTURE_ASSETS.parcelLeaf, kind: "transfer", from: FIXTURE_WALLETS.custodian, to: FIXTURE_WALLETS.buyer, amount: 1n, slot: 310_001_500n, txIndex: 1, ixIndex: 2, signature: sig(34) },
];
