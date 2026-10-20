/** Request bodies for the RWA API. Addresses are checked per rail by the API (packages/chain). */
import { z } from "zod";
import { KYC_STATUSES, PARTY_KINDS, SCREENING_OUTCOMES } from "./compliance";
import { NETWORKS, baseUnits } from "./model";
import { INVESTOR_ORDER_KINDS } from "./orders";

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
    kind: z.enum(INVESTOR_ORDER_KINDS),
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

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ring = z.array(position).min(4);
/** Surveyed geometry: a point (a tree, an animal's pen) or an area (a parcel). WGS 84 longitude, latitude. */
export const assetGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: position }).strict(),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1).max(20) }).strict(),
]);

export const createAssetSchema = z
  .object({
    farmId: z.string().uuid(),
    kind: z.enum(["parcel", "tree", "livestock", "equipment", "harvest_lot", "farm_share"]),
    name: z.string().trim().min(1).max(200),
    externalRef: z.string().trim().min(1).max(120).optional(),
    parcelLabel: z.string().trim().min(1).max(80).optional(),
    geometry: assetGeometrySchema.optional(),
    geomProvenance: z.enum(["surveyed", "gnss", "user-entered"]).optional(),
  })
  .strict()
  .refine((a) => !a.geometry === !a.geomProvenance, { message: "say how the geometry was measured", path: ["geomProvenance"] });

export const createRepresentationSchema = z
  .object({ network: z.enum(["solana-devnet", "solana-mainnet"]), decimals: z.number().int().min(0).max(9) })
  .strict();

export const linkMintSchema = z.object({ mintAddress: z.string().trim().min(32).max(44) }).strict();

/** Records a verified one-of-a-kind asset as a compressed NFT held by a custodian party. */
export const createRegistrationSchema = z
  .object({
    network: z.enum(["solana-devnet", "solana-mainnet"]),
    /** The custodian: a party with verified KYC whose Solana wallet below is screened. */
    partyId: z.string().uuid(),
    solanaWallet: z.string().trim().min(32).max(44),
  })
  .strict();
