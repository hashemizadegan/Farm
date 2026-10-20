/**
 * Unsigned intents: complete, fingerprinted descriptions of a mint, a transfer or a trade of a farm
 * asset, exposed only as data. An intent carries no key material and no signature, builds no
 * transaction bytes, and cannot be submitted (`submission.available` is always false). It is what
 * a reviewer, an approval flow or a future wallet-signing step would look at.
 *
 * Every intent is checked against chain ownership the way `previewTransfer` is: a transfer or trade
 * is refused unless the current holders are known and cover each leg; a mint is refused for a
 * compressed NFT that already has a holder. Mainnets stay closed unless explicitly enabled.
 */
import { canonicalJson } from "../harvest";
import { networkAllowed } from "../rwa/model";
import { contentHash } from "./commitments";
import type { ChainAssetRef } from "./ownership";
import type { OwnershipReading, SubmissionUnavailableReason } from "./ports";
import { TransferRefused } from "./transfer";

export const INTENT_SCHEME = "metafarm-intent/1";
export const INTENT_KINDS = ["mint", "transfer", "trade"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];
export const INTENT_TTL_SECONDS = 300;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** One movement of one asset. `from` is null for a mint. */
export interface IntentLeg {
  asset: ChainAssetRef;
  from: string | null;
  to: string;
  amount: bigint;
}

export interface UnsignedIntent {
  scheme: typeof INTENT_SCHEME;
  kind: IntentKind;
  legs: IntentLeg[];
  /** Wallets whose signatures a transaction for this intent would need (none are collected here). */
  requiredSigners: string[];
  createdAt: Date;
  expiresAt: Date;
  /** SHA-256 of the canonical intent; a signature request must carry the same digest. */
  digest: string;
  /** Slot of the ownership readings the intent was checked against, per leg (null when unknown). */
  ownershipAsOfSlots: (bigint | null)[];
  signatures: [];
  submission: { available: false; reason: SubmissionUnavailableReason };
}

interface Context {
  now: Date;
  mainnetEnabled: boolean;
  submissionUnavailable: SubmissionUnavailableReason;
  ttlSeconds?: number;
}

function checkLeg(leg: IntentLeg) {
  const { asset, from, to, amount } = leg;
  if (asset.rail !== "SOLANA_TOKEN_2022" && asset.rail !== "SOLANA_BUBBLEGUM_CNFT")
    throw new TransferRefused("rail_not_transferable", "only Solana share tokens and compressed NFTs are supported");
  if (!BASE58.test(asset.id) || !BASE58.test(to) || (from !== null && !BASE58.test(from))) throw new TransferRefused("invalid_address", "addresses must be base58 Solana addresses");
  if (from !== null && from === to) throw new TransferRefused("same_address", "sender and recipient are the same");
  if (amount <= 0n || amount > U64_MAX) throw new TransferRefused("invalid_amount", "amount must be a positive u64");
  if (asset.rail === "SOLANA_BUBBLEGUM_CNFT" && amount !== 1n) throw new TransferRefused("invalid_amount", "a compressed NFT moves whole (amount 1)");
}

function checkNetwork(legs: IntentLeg[], ctx: Context) {
  for (const l of legs) if (!networkAllowed(l.asset.network, { mainnetEnabled: ctx.mainnetEnabled })) throw new TransferRefused("network_not_allowed", `${l.asset.network} is not enabled`);
  if (new Set(legs.map((l) => l.asset.network)).size !== 1) throw new TransferRefused("network_not_allowed", "every leg must be on the same network");
}

function checkHeld(leg: IntentLeg, holders: OwnershipReading | null) {
  if (!holders) throw new TransferRefused("ownership_not_indexed", "the asset's current holders on chain are not known");
  const held = holders.holders.find((h) => h.owner === leg.from)?.amount ?? 0n;
  if (held < leg.amount) throw new TransferRefused("sender_not_holder", "the sender does not hold enough of this asset on chain");
}

async function finish(kind: IntentKind, legs: IntentLeg[], requiredSigners: string[], slots: (bigint | null)[], ctx: Context): Promise<UnsignedIntent> {
  const createdAt = ctx.now;
  const expiresAt = new Date(createdAt.getTime() + (ctx.ttlSeconds ?? INTENT_TTL_SECONDS) * 1000);
  const digest = await contentHash(
    canonicalJson({
      scheme: INTENT_SCHEME,
      kind,
      legs: legs.map((l) => ({ asset: l.asset, from: l.from, to: l.to, amount: l.amount.toString() })),
      requiredSigners,
      expiresAt: expiresAt.toISOString(),
    }),
  );
  return { scheme: INTENT_SCHEME, kind, legs, requiredSigners, createdAt, expiresAt, digest, ownershipAsOfSlots: slots, signatures: [], submission: { available: false, reason: ctx.submissionUnavailable } };
}

/**
 * A mint to `to` by the platform's issuer. For a compressed NFT the asset must have no holder yet
 * (when the chain says so); a share-token mint may top up supply. The issuer is a public address:
 * no key is involved here.
 */
export async function buildMintIntent(p: { asset: ChainAssetRef; issuer: string; to: string; amount: bigint; holders: OwnershipReading | null }, ctx: Context): Promise<UnsignedIntent> {
  const leg: IntentLeg = { asset: p.asset, from: null, to: p.to, amount: p.amount };
  checkLeg(leg);
  checkNetwork([leg], ctx);
  if (!BASE58.test(p.issuer)) throw new TransferRefused("invalid_address", "the issuer must be a base58 Solana address");
  if (p.asset.rail === "SOLANA_BUBBLEGUM_CNFT") {
    if (!p.holders) throw new TransferRefused("ownership_not_indexed", "whether this compressed NFT exists on chain is not known");
    if (p.holders.holders.some((h) => h.amount > 0n)) throw new TransferRefused("invalid_amount", "this compressed NFT already exists on chain");
  }
  return finish("mint", [leg], [p.issuer], [p.holders?.asOfSlot ?? null], ctx);
}

export async function buildTransferIntent(p: { leg: IntentLeg & { from: string }; holders: OwnershipReading | null }, ctx: Context): Promise<UnsignedIntent> {
  checkLeg(p.leg);
  checkNetwork([p.leg], ctx);
  checkHeld(p.leg, p.holders);
  return finish("transfer", [p.leg], [p.leg.from], [p.holders!.asOfSlot], ctx);
}

/**
 * A trade: the asset moves seller → buyer and the payment (a Token-2022 mint, e.g. a stablecoin)
 * moves buyer → seller, both in one transaction so neither leg can land alone. Both parties sign.
 */
export async function buildTradeIntent(
  p: { asset: ChainAssetRef; seller: string; buyer: string; amount: bigint; payment: ChainAssetRef; price: bigint; assetHolders: OwnershipReading | null; paymentHolders: OwnershipReading | null },
  ctx: Context,
): Promise<UnsignedIntent> {
  if (p.payment.rail !== "SOLANA_TOKEN_2022") throw new TransferRefused("rail_not_transferable", "payment must be a Token-2022 token");
  if (p.payment.id === p.asset.id) throw new TransferRefused("invalid_amount", "an asset cannot pay for itself");
  const assetLeg: IntentLeg = { asset: p.asset, from: p.seller, to: p.buyer, amount: p.amount };
  const paymentLeg: IntentLeg = { asset: p.payment, from: p.buyer, to: p.seller, amount: p.price };
  for (const l of [assetLeg, paymentLeg]) checkLeg(l);
  checkNetwork([assetLeg, paymentLeg], ctx);
  checkHeld(assetLeg, p.assetHolders);
  checkHeld(paymentLeg, p.paymentHolders);
  return finish("trade", [assetLeg, paymentLeg], [p.seller, p.buyer], [p.assetHolders!.asOfSlot, p.paymentHolders!.asOfSlot], ctx);
}

/** JSON form of an intent (bigints and dates as strings), for APIs and clients. */
export function intentToJson(i: UnsignedIntent) {
  return {
    scheme: i.scheme,
    kind: i.kind,
    legs: i.legs.map((l) => ({ asset: l.asset, from: l.from, to: l.to, amount: l.amount.toString() })),
    requiredSigners: i.requiredSigners,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    digest: i.digest,
    ownershipAsOfSlots: i.ownershipAsOfSlots.map((s) => (s === null ? null : s.toString())),
    signatures: [] as never[],
    submission: i.submission,
  };
}
