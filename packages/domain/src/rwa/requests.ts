/** Request bodies for the RWA API. Addresses are checked per rail by the API (packages/chain). */
import { z } from "zod";
import { KYC_STATUSES, PARTY_KINDS, SCREENING_OUTCOMES } from "./compliance";
import { NETWORKS, baseUnits } from "./model";
import { ORDER_KINDS } from "./orders";

const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "a two-letter country code")
  .transform((c) => c.toUpperCase());

export const createPartySchema = z
  .object({ kind: z.enum(PARTY_KINDS), displayName: z.string().trim().min(1).max(200), jurisdiction: country.nullable().optional() })
  .strict();

export const kycSchema = z
  .object({
    status: z.enum(KYC_STATUSES),
    /** The KYC provider's case reference; required to mark someone verified. */
    reference: z.string().trim().min(1).max(200).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((k) => k.status !== "verified" || !!k.reference, { message: "a provider reference is required to verify", path: ["reference"] });

export const walletSchema = z.object({ network: z.enum(NETWORKS), address: z.string().trim().min(20).max(64) }).strict();

export const screeningSchema = z
  .object({
    /** Omit to record a screening of the party itself. */
    walletId: z.string().uuid().optional(),
    provider: z.string().trim().min(1).max(100),
    providerReference: z.string().trim().min(1).max(200),
    outcome: z.enum(SCREENING_OUTCOMES),
    reasons: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const createOrderSchema = z
  .object({
    kind: z.enum(ORDER_KINDS),
    partyId: z.string().uuid(),
    representationId: z.string().uuid().optional(),
    shareAmount: baseUnits.optional(),
    settlementNetwork: z.enum(["tron-nile", "tron-shasta", "tron-mainnet"]),
    tokenContract: z.string().trim().min(20).max(64),
    settlementAmount: baseUnits,
    /** The investor's TRON wallet: payer of a subscription, payee of a redemption or distribution. */
    tronWallet: z.string().trim().min(20).max(64),
    /** The investor's Solana wallet that holds the shares (subscriptions and redemptions). */
    solanaWallet: z.string().trim().min(20).max(64).optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const shares = o.kind !== "distribution";
    if (shares && (!o.representationId || !o.shareAmount || !o.solanaWallet)) {
      ctx.addIssue({ code: "custom", path: ["shareAmount"], message: "subscriptions and redemptions need the share token, a share amount and a Solana wallet" });
    }
    if (!shares && (o.representationId || o.shareAmount)) ctx.addIssue({ code: "custom", path: ["shareAmount"], message: "a distribution moves money only" });
    if (o.shareAmount === "0" || o.settlementAmount === "0") ctx.addIssue({ code: "custom", path: ["settlementAmount"], message: "amounts must be positive" });
  });

export const paymentSchema = z.object({ txId: z.string().regex(/^[0-9a-fA-F]{64}$/, "a 64-character TRON transaction id") }).strict();
