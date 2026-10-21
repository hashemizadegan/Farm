/**
 * The digital twin for a separate 3D client: a farm's scene, an asset's identities and ownership,
 * verifiable off-chain data, transfer previews and the state of chain work. Read-mostly.
 *
 * Trust rules:
 * - Ownership comes only from an `OwnershipReader` (the chain or an indexer of it). Without one the
 *   API says `not_indexed`; it never falls back to its own records.
 * - Data commitments are recorded as submitted. A commitment is `included` only when its Merkle
 *   proof to the batch root is re-checked on read; nothing here writes or checks on-chain anchors.
 * - A transfer preview prepares nothing that could be submitted: submission is unavailable.
 * - Assets and their chain identities need `rwa:read`, as in the RWA API; the scene shows the farm
 *   itself to anyone with `farm:read` and lists which layers it withheld.
 */
import type { FastifyInstance } from "fastify";
import {
  commitmentBatchLeaves,
  findCommitmentBatchByRequest,
  findDataCommitmentByRequest,
  getBusinessAsset,
  getCommitmentBatch,
  getDataCommitment,
  getFarm,
  getOperation,
  insertCommitmentBatch,
  insertDataCommitment,
  commitmentsInOrder,
  listDataCommitments,
  twinAssetsOfFarm,
  twinChainCounts,
  twinChainIdentities,
  twinChainIdentity,
  type BusinessAssetRow,
  type CommitmentBatchRow,
  type DataCommitmentRow,
  type TwinChainRow,
  listPlayerWallets,
} from "@metafarm/db";
import { createTransactionSubmitter } from "@metafarm/chain";
import {
  ASSET_KINDS,
  DATA_SUBJECT_TYPES,
  MERKLE_SCHEME,
  RAILS,
  SNAPSHOT_COMMITMENT_SCHEMA,
  TWIN_LAYERS,
  TWIN_SCENE_SCHEME,
  TransferRefused,
  can,
  checkStorageRef,
  createCommitmentBatchSchema,
  createDataCommitmentSchema,
  merkleAuditPath,
  merkleLeaf,
  merkleRoot,
  previewTransfer,
  transferPreviewSchema,
  twinLayerOf,
  twinObjectId,
  verificationStateOf,
  verifyMerkleInclusion,
  type AssetKind,
  type ChainAssetRef,
  type Network,
  type OwnershipReading,
  type Rail,
  type TransferPreview,
  type TwinLayer,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, idempotencyKey, keyReused, notFound, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: z.string().uuid() });
const farmParams = tenantParams.extend({ farmId: z.string().uuid() });
const assetParams = tenantParams.extend({ assetId: z.string().uuid() });
const commitmentParams = tenantParams.extend({ commitmentId: z.string().uuid() });
const operationParams = tenantParams.extend({ operationId: z.string().uuid() });
const sceneQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), cursor: z.string().uuid().optional() }).strict();
const commitmentQuery = z
  .object({
    subjectType: z.enum(DATA_SUBJECT_TYPES).optional(),
    subjectId: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

const ASSET_LAYERS: TwinLayer[] = TWIN_LAYERS.filter((l) => l !== "terrain");
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function toChain(r: TwinChainRow) {
  return { representationId: r.id, rail: r.rail, network: r.network, status: r.status, chainId: r.chain_id };
}

function toObject(a: BusinessAssetRow, chain: TwinChainRow[]) {
  const kind = (ASSET_KINDS as readonly string[]).includes(a.kind) ? (a.kind as AssetKind) : undefined;
  if (!kind) throw new Error(`unknown asset kind ${a.kind}`);
  return {
    twinObjectId: twinObjectId(a.id),
    assetId: a.id,
    layer: twinLayerOf(kind),
    kind,
    name: a.name,
    status: a.status,
    geometry: a.geometry,
    physical: { externalRef: a.external_ref, parcelLabel: a.parcel_label, geomProvenance: a.geom_provenance, verifiedAt: iso(a.verified_at) },
    chain: chain.filter((c) => c.asset_id === a.id).map(toChain),
  };
}

export function toCommitment(r: DataCommitmentRow) {
  return {
    id: r.id,
    farmId: r.farm_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    schema: r.data_schema,
    schemaVersion: r.schema_version,
    contentSha256: r.content_sha256,
    byteSize: r.byte_size === null ? null : Number(r.byte_size),
    storageRef: r.storage_ref,
    sourceTime: iso(r.source_time)!,
    attestationRef: r.attestation_ref,
    batch: r.batch_id === null ? null : { id: r.batch_id, leafIndex: r.leaf_index! },
    createdAt: iso(r.created_at)!,
  };
}

const chainRef = (r: TwinChainRow): ChainAssetRef | null =>
  r.chain_id && (RAILS as readonly string[]).includes(r.rail) ? { network: r.network as Network, rail: r.rail as Rail, id: r.chain_id } : null;

export async function twinRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const submitter = () => createTransactionSubmitter({ signerConfigured: false, network: "solana-devnet", mainnetEnabled: env.RWA_MAINNET_ENABLED });

  /** What the chain says about one representation, or why it cannot be said. */
  async function ownershipOf(r: TwinChainRow) {
    const ref = chainRef(r);
    if (!ref) return { representationId: r.id, status: "not_on_chain" as const };
    const reader = app.deps.ownershipReader;
    if (!reader) return { representationId: r.id, status: "not_indexed" as const, reason: "no_ownership_reader" as const };
    try {
      const reading = await reader.holdersOf(ref);
      if (!reading) return { representationId: r.id, status: "not_indexed" as const, reason: "not_covered" as const };
      return {
        representationId: r.id,
        status: "indexed" as const,
        source: reader.source,
        assurance: reading.assurance,
        asOfSlot: reading.asOfSlot === null ? null : reading.asOfSlot.toString(),
        holders: reading.holders.map((h) => ({ owner: h.owner, amount: h.amount.toString() })),
      };
    } catch {
      return { representationId: r.id, status: "not_indexed" as const, reason: "reader_unavailable" as const };
    }
  }

  /**
   * J8, read-only: whether the caller's own linked player wallets hold the asset. Stated only for
   * ownership read from the chain (never for fixture data or unknown ownership), only when player
   * wallets are enabled, and only when the caller has linked at least one; otherwise the field is
   * absent. It looks at player wallets only, never at RWA party wallets.
   */
  type Ownership = Awaited<ReturnType<typeof ownershipOf>>;
  async function withHeldByYou(userId: string, readings: Ownership[]): Promise<Array<Ownership & { heldByYou?: boolean }>> {
    if (!env.PLAYER_WALLETS_ENABLED || !readings.some((o) => o.status === "indexed" && o.source !== "fixture")) return readings;
    const mine = new Set((await listPlayerWallets(app.deps.pool, userId)).map((w) => w.address));
    if (mine.size === 0) return readings;
    return readings.map((o) =>
      o.status === "indexed" && o.source !== "fixture" ? { ...o, heldByYou: o.holders.some((h) => mine.has(h.owner) && BigInt(h.amount) > 0n) } : o,
    );
  }

  // ── Scene ─────────────────────────────────────────────────────────────

  app.get("/v1/tenants/:tenantId/twin/farms/:farmId/scene", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const q = parse(sceneQuery, req.query);
    return app.inTenant(req, "farm:read", async (tx, ctx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      const seesAssets = can(ctx.role, "rwa:read");
      let objects: ReturnType<typeof toObject>[] = [];
      let nextCursor: string | null = null;
      if (seesAssets) {
        const rows = await twinAssetsOfFarm(tx, farmId, q.limit + 1, q.cursor);
        const page = rows.slice(0, q.limit);
        const chain = await twinChainIdentities(tx, page.map((a) => a.id));
        objects = page.map((a) => toObject(a, chain));
        nextCursor = rows.length > q.limit ? page.at(-1)!.id : null;
      }
      return {
        scheme: TWIN_SCENE_SCHEME,
        generatedAt: app.deps.now().toISOString(),
        farm: { id: farm.id, name: farm.name, origin: farm.origin, outline: farm.outline },
        redacted: seesAssets ? [] : ASSET_LAYERS,
        objects,
        nextCursor,
      };
    });
  });

  // ── One asset ─────────────────────────────────────────────────────────

  app.get("/v1/tenants/:tenantId/twin/assets/:assetId", async (req) => {
    const { assetId } = parse(assetParams, req.params);
    const { asset, chain, commitments } = await app.inTenant(req, "rwa:read", async (tx) => {
      const a = await getBusinessAsset(tx, assetId);
      if (!a) throw notFound("asset");
      return {
        asset: a,
        chain: await twinChainIdentities(tx, [a.id]),
        commitments: await listDataCommitments(tx, { subjectType: "asset", subjectId: a.id, limit: 20 }),
      };
    });
    // Chain reads happen outside the database transaction.
    const read = await Promise.all(chain.map(ownershipOf));
    const ownership = await withHeldByYou(req.user!.id, read);
    const lifecycle = [
      { event: "registered", at: iso(asset.created_at)! },
      ...(asset.verified_at ? [{ event: "verified", at: iso(asset.verified_at)! }] : []),
    ];
    return { object: toObject(asset, chain), lifecycle, ownership, dataCommitments: commitments.map(toCommitment) };
  });

  // ── Data commitments ──────────────────────────────────────────────────

  app.post("/v1/tenants/:tenantId/twin/data-commitments", { config: { idempotency: "handler" } }, async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createDataCommitmentSchema, req.body);
    if (body.schema === SNAPSHOT_COMMITMENT_SCHEMA) throw new HttpError(400, "reserved_schema", "snapshot commitments are recorded by the snapshot endpoint");
    if (body.storageRef) {
      const ref = checkStorageRef(body.storageRef, body.contentSha256);
      if ("error" in ref) throw new HttpError(400, "storage_ref_not_content_addressed", ref.error);
    }
    const key = idempotencyKey(req);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      if (key) {
        const seen = await findDataCommitmentByRequest(tx, key);
        if (seen) {
          const same = seen.content_sha256 === body.contentSha256 && seen.subject_type === body.subjectType && seen.subject_id === body.subjectId && seen.data_schema === body.schema && seen.schema_version === body.schemaVersion;
          if (!same || seen.recorded_by !== req.user!.id) throw keyReused();
          return { row: seen, created: false };
        }
      }
      if (body.farmId && !(await getFarm(tx, body.farmId))) throw notFound("farm");
      if (body.subjectType === "asset") {
        if (!z.string().uuid().safeParse(body.subjectId).success || !(await getBusinessAsset(tx, body.subjectId))) throw new HttpError(400, "unknown_subject", "subjectId must be an asset of this workspace");
      }
      if (body.subjectType === "farm" && (!z.string().uuid().safeParse(body.subjectId).success || !(await getFarm(tx, body.subjectId))))
        throw new HttpError(400, "unknown_subject", "subjectId must be a farm of this workspace");
      const res = await insertDataCommitment(tx, {
        farmId: body.farmId ?? null,
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        schema: body.schema,
        schemaVersion: body.schemaVersion,
        contentSha256: body.contentSha256,
        byteSize: body.byteSize ?? null,
        storageRef: body.storageRef ?? null,
        sourceTime: new Date(body.sourceTime),
        attestationRef: body.attestationRef ?? null,
        recordedBy: req.user!.id,
        clientRequestId: key ?? null,
      });
      if (res.created)
        await app.audit(req, tx, {
          action: "twin.commitment.recorded",
          targetType: "data_commitment",
          targetId: res.row.id,
          metadata: { subjectType: body.subjectType, subjectId: body.subjectId, schema: body.schema, contentSha256: body.contentSha256 },
        });
      return res;
    });
    return reply.status(out.created ? 201 : 200).send(toCommitment(out.row));
  });

  app.get("/v1/tenants/:tenantId/twin/data-commitments", async (req) => {
    parse(tenantParams, req.params);
    const q = parse(commitmentQuery, req.query);
    return app.inTenant(req, "rwa:read", async (tx) => {
      const rows = await listDataCommitments(tx, { subjectType: q.subjectType, subjectId: q.subjectId, limit: q.limit + 1, before: q.cursor });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toCommitment), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    });
  });

  app.post("/v1/tenants/:tenantId/twin/data-commitments/batches", { config: { idempotency: "handler" } }, async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createCommitmentBatchSchema, req.body);
    if (new Set(body.commitmentIds).size !== body.commitmentIds.length) throw new HttpError(400, "duplicate_commitments", "each commitment may appear once in a batch");
    const key = idempotencyKey(req);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      if (key) {
        const seen = await findCommitmentBatchByRequest(tx, key);
        if (seen) {
          const leaves = await commitmentBatchLeaves(tx, seen.id);
          const same = seen.dataset === body.dataset && leaves.map((l) => l.commitment_id).join() === body.commitmentIds.join();
          if (!same || seen.created_by !== req.user!.id) throw keyReused();
          return { batch: seen, created: false };
        }
      }
      const rows = await commitmentsInOrder(tx, body.commitmentIds);
      if (rows.length !== body.commitmentIds.length) throw new HttpError(400, "unknown_commitments", "every commitment must exist in this workspace");
      const batched = rows.filter((r) => r.batch_id !== null).map((r) => r.id);
      if (batched.length) throw new HttpError(409, "already_batched", "a commitment joins at most one batch", { commitmentIds: batched });
      const leaves = await Promise.all(rows.map((r) => merkleLeaf(r.content_sha256)));
      const root = await merkleRoot(leaves);
      let batch: CommitmentBatchRow;
      try {
        await tx.query("SAVEPOINT twin_batch");
        batch = await insertCommitmentBatch(tx, {
          dataset: body.dataset,
          scheme: MERKLE_SCHEME,
          merkleRoot: root,
          leaves: rows.map((r, i) => ({ commitmentId: r.id, leafHash: leaves[i]! })),
          createdBy: req.user!.id,
          clientRequestId: key ?? null,
        });
      } catch (err) {
        // Another batch took one of these commitments in the meantime (unique commitment_id).
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "already_batched", "a commitment joins at most one batch");
        throw err;
      }
      await app.audit(req, tx, { action: "twin.batch.created", targetType: "commitment_batch", targetId: batch.id, metadata: { dataset: body.dataset, merkleRoot: root, leafCount: rows.length } });
      return { batch, created: true };
    });
    const b = out.batch;
    return reply.status(out.created ? 201 : 200).send({
      id: b.id,
      dataset: b.dataset,
      scheme: b.scheme,
      merkleRoot: b.merkle_root,
      leafCount: b.leaf_count,
      anchor: null,
      createdAt: iso(b.created_at)!,
    });
  });

  app.get("/v1/tenants/:tenantId/twin/data-commitments/:commitmentId/proof", async (req) => {
    const { commitmentId } = parse(commitmentParams, req.params);
    return app.inTenant(req, "rwa:read", async (tx) => {
      const c = await getDataCommitment(tx, commitmentId);
      if (!c) throw notFound("commitment");
      if (c.batch_id === null) {
        return { commitment: toCommitment(c), state: verificationStateOf({ inclusionVerified: false, anchorConfirmedOnChain: false }), proof: null, anchor: null };
      }
      const batch = (await getCommitmentBatch(tx, c.batch_id))!;
      const leaves = await commitmentBatchLeaves(tx, batch.id);
      const leaf = await merkleLeaf(c.content_sha256);
      // Re-check from the stored leaves: each leaf still matches its commitment, the root still matches.
      const leavesMatch = (await Promise.all(leaves.map(async (l) => (await merkleLeaf(l.content_sha256)) === l.leaf_hash))).every(Boolean);
      const hashes = leaves.map((l) => l.leaf_hash);
      const rootMatches = leavesMatch && (await merkleRoot(hashes)) === batch.merkle_root;
      const path = await merkleAuditPath(hashes, c.leaf_index!);
      const inclusionVerified = rootMatches && (await verifyMerkleInclusion({ leaf, index: c.leaf_index!, size: batch.leaf_count, path, root: batch.merkle_root }));
      return {
        commitment: toCommitment(c),
        state: verificationStateOf({ inclusionVerified, anchorConfirmedOnChain: false }),
        proof: { scheme: batch.scheme, batchId: batch.id, dataset: batch.dataset, leaf, leafIndex: c.leaf_index!, size: batch.leaf_count, path, root: batch.merkle_root },
        checks: { leavesMatchCommitments: leavesMatch, rootMatches, inclusionVerified },
        anchor: null,
      };
    });
  });

  // ── Transfers: preparation only ───────────────────────────────────────

  app.post("/v1/tenants/:tenantId/twin/transfers/preview", async (req) => {
    parse(tenantParams, req.params);
    const body = parse(transferPreviewSchema, req.body);
    const rep = await app.inTenant(req, "rwa:operate", (tx) => twinChainIdentity(tx, body.representationId));
    if (!rep) throw notFound("representation");
    const ref = chainRef(rep);
    if (!ref) throw new HttpError(409, "not_on_chain", "this representation has no chain identity yet");
    const reader = app.deps.ownershipReader;
    let holders: OwnershipReading | null = null;
    if (reader) {
      try {
        holders = await reader.holdersOf(ref);
      } catch {
        holders = null;
      }
    }
    const s = submitter();
    let preview: TransferPreview;
    try {
      preview = await previewTransfer(
        { asset: ref, from: body.from, to: body.to, amount: BigInt(body.amount) },
        { now: app.deps.now(), mainnetEnabled: env.RWA_MAINNET_ENABLED, holders, submissionUnavailable: s.reason! },
      );
    } catch (err) {
      if (err instanceof TransferRefused) throw new HttpError(409, err.code, err.message);
      throw err;
    }
    await app.inTenant(req, "rwa:operate", (tx) =>
      app.audit(req, tx, {
        action: "twin.transfer.previewed",
        targetType: "asset_representation",
        targetId: rep.id,
        metadata: { digest: preview.digest, from: preview.from, to: preview.to, amount: preview.amount.toString() },
      }),
    );
    return {
      scheme: preview.scheme,
      representationId: rep.id,
      asset: preview.asset,
      from: preview.from,
      to: preview.to,
      amount: preview.amount.toString(),
      createdAt: preview.createdAt.toISOString(),
      expiresAt: preview.expiresAt.toISOString(),
      digest: preview.digest,
      ownershipAsOfSlot: preview.ownershipAsOfSlot === null ? null : preview.ownershipAsOfSlot.toString(),
      submission: preview.submission,
    };
  });

  // ── Chain work and sync status ────────────────────────────────────────

  app.get("/v1/tenants/:tenantId/twin/transactions/:operationId", async (req) => {
    const { operationId } = parse(operationParams, req.params);
    return app.inTenant(req, "rwa:read", async (tx) => {
      const op = await getOperation(tx, operationId);
      if (!op) throw notFound("transaction");
      return {
        id: op.id,
        intentType: op.intent_type,
        intentId: op.intent_id,
        attempt: op.attempt,
        network: op.network,
        state: op.state,
        txRef: op.tx_ref,
        expiresAt: iso(op.expires_at),
        failed: op.state === "failed",
      };
    });
  });

  app.get("/v1/tenants/:tenantId/twin/sync-status", async (req) => {
    parse(tenantParams, req.params);
    const counts = await app.inTenant(req, "rwa:read", async (tx) => {
      const chain = await twinChainCounts(tx);
      const c = await tx.query<{ total: string; batched: string; batches: string }>(
        `SELECT (SELECT count(*) FROM data_commitments WHERE tenant_id = $1) AS total,
                (SELECT count(*) FROM commitment_batch_leaves WHERE tenant_id = $1) AS batched,
                (SELECT count(*) FROM commitment_batches WHERE tenant_id = $1) AS batches`,
        [tx.tenantId],
      );
      return { chain, commitments: c.rows[0]! };
    });
    const reader = app.deps.ownershipReader;
    const s = submitter();
    return {
      ownership: reader ? { status: "configured", source: reader.source } : { status: "not_configured", source: null },
      submission: { available: s.available, reason: s.reason ?? null },
      representations: { total: counts.chain.representations, withChainId: counts.chain.with_chain_id, active: counts.chain.active },
      dataCommitments: { total: Number(counts.commitments.total), batched: Number(counts.commitments.batched), batches: Number(counts.commitments.batches), anchoredBatches: 0 },
    };
  });
}
