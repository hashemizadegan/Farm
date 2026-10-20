/**
 * Anchor plans for Merkle roots: what would be written on Solana to anchor a commitment batch or a
 * farm snapshot (packages/domain/src/twin/anchor.ts). Read-only and data-only: every plan says
 * `executable: false`; nothing is stored, signed, sent or written on-chain.
 */
import type { FastifyInstance } from "fastify";
import { getCommitmentBatch, getDataCommitment } from "@metafarm/db";
import { ANCHOR_CARRIERS, ContentIntegrityError, SNAPSHOT_COMMITMENT_SCHEMA, planAnchor, reconstructFarmSnapshot, type AnchorPlan } from "@metafarm/domain";
import { createObjectContentStore } from "@metafarm/storage";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const planQuery = z.object({ carrier: z.enum(ANCHOR_CARRIERS), network: z.enum(["solana-devnet", "solana-mainnet"]).default("solana-devnet") }).strict();
const batchParams = z.object({ tenantId: z.string().uuid(), batchId: z.string().uuid() });
const snapshotParams = z.object({ tenantId: z.string().uuid(), commitmentId: z.string().uuid() });

/** A short, stable label for a farm: `farm-` and the first 14 hex digits of its id (keys stay ≤ 32 bytes). */
export const farmAnchorLabel = (farmId: string) => `farm-${farmId.replace(/-/g, "").slice(0, 14)}`;

export async function twinAnchorRoutes(app: FastifyInstance) {
  const { env } = app.deps;

  function plan(p: { carrier: (typeof ANCHOR_CARRIERS)[number]; network: "solana-devnet" | "solana-mainnet"; subject: "batch" | "snapshot"; root: string; label: string }): AnchorPlan {
    if (p.carrier === "bubblegum_v1_leaf" && !env.RWA_CNFT_METADATA_BASE_URL)
      throw new HttpError(409, "not_configured", "a Bubblegum anchor plan needs RWA_CNFT_METADATA_BASE_URL (the public anchor document base)");
    try {
      return planAnchor({ ...p, documentBaseUrl: env.RWA_CNFT_METADATA_BASE_URL, mainnetEnabled: env.RWA_MAINNET_ENABLED });
    } catch (err) {
      if (err instanceof RangeError) throw new HttpError(422, "anchor_plan_refused", err.message);
      throw err;
    }
  }

  app.get("/v1/tenants/:tenantId/twin/data-commitments/batches/:batchId/anchor-plan", async (req) => {
    const { batchId } = parse(batchParams, req.params);
    const q = parse(planQuery, req.query);
    const batch = await app.inTenant(req, "rwa:read", (tx) => getCommitmentBatch(tx, batchId));
    if (!batch) throw notFound("batch");
    return { batchId: batch.id, plan: plan({ carrier: q.carrier, network: q.network, subject: "batch", root: batch.merkle_root, label: batch.dataset }) };
  });

  app.get("/v1/tenants/:tenantId/twin/snapshots/:commitmentId/anchor-plan", async (req) => {
    const { tenantId, commitmentId } = parse(snapshotParams, req.params);
    const q = parse(planQuery, req.query);
    const c = await app.inTenant(req, "rwa:read", (tx) => getDataCommitment(tx, commitmentId));
    if (!c || c.data_schema !== SNAPSHOT_COMMITMENT_SCHEMA) throw notFound("snapshot");
    let bytes: Uint8Array | null;
    try {
      bytes = await createObjectContentStore(app.deps.storage, tenantId).get(c.content_sha256);
    } catch (err) {
      if (err instanceof ContentIntegrityError) throw new HttpError(409, "content_integrity_failed", "the stored snapshot no longer matches its hash");
      throw err;
    }
    if (!bytes) throw new HttpError(404, "snapshot_content_missing", "the snapshot's bytes are not in storage");
    const { snapshot, check } = await reconstructFarmSnapshot(new TextDecoder().decode(bytes));
    if (!check.ok) throw new HttpError(409, "snapshot_not_verified", "the stored snapshot does not verify; it cannot be anchored");
    return {
      commitmentId: c.id,
      snapshotId: snapshot.snapshotId,
      plan: plan({ carrier: q.carrier, network: q.network, subject: "snapshot", root: snapshot.root, label: farmAnchorLabel(snapshot.farmId) }),
    };
  });
}
