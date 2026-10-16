import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createPendingMedia, getFarm, getMedia, listAudit, setMediaStatus } from "@metafarm/db";
import { createUploadSchema, uuid } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { toMedia } from "../lib/mappers";
import { buildStorageKey } from "../storage/object-storage";

/** Purposes allowed per content type. GeoJSON is only accepted for boundary imports, models only for assets. */
const ALLOWED: Record<string, readonly string[]> = {
  "boundary-import": ["application/geo+json"],
  "observation-photo": ["image/jpeg", "image/png", "image/webp"],
  "verification-evidence": ["application/pdf", "image/jpeg", "image/png"],
  "asset-model": ["model/gltf-binary"],
};

export async function mediaRoutes(app: FastifyInstance) {
  app.post("/v1/tenants/:tenantId/uploads", async (req, reply) => {
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    const body = parse(createUploadSchema, req.body);
    const { env, storage } = app.deps;

    if (body.byteSize > env.UPLOAD_MAX_BYTES) {
      throw new HttpError(413, "payload_too_large", `uploads are limited to ${env.UPLOAD_MAX_BYTES} bytes`);
    }
    if (!ALLOWED[body.purpose]?.includes(body.contentType)) {
      throw new HttpError(400, "content_type_not_allowed", `${body.contentType} is not accepted for ${body.purpose}`);
    }

    const { media, ticket } = await app.inTenant(req, "media:upload", async (tx) => {
      if (body.farmId && !(await getFarm(tx, body.farmId))) throw notFound("farm");
      const key = buildStorageKey(tenantId, body.purpose, randomUUID());
      const m = await createPendingMedia(tx, { ...body, storageKey: key, userId: req.user!.id });
      const t = await storage.presignPut(key, {
        contentType: body.contentType,
        byteSize: body.byteSize,
        ttlSeconds: env.UPLOAD_URL_TTL_SECONDS,
      });
      await app.audit(req, tx, { action: "media.upload_requested", targetType: "media_object", targetId: m.id, metadata: { purpose: body.purpose, byteSize: body.byteSize } });
      return { media: m, ticket: t };
    });

    return reply.status(201).send({
      mediaId: media.id,
      uploadUrl: ticket.url,
      method: ticket.method,
      headers: ticket.headers,
      expiresAt: ticket.expiresAt.toISOString(),
    });
  });

  /**
   * Confirms an upload. The stored object's size and content type must match
   * what was declared; otherwise the object is deleted and the record rejected.
   * Content scanning (malware, image re-encoding) is a TODO hook for the
   * provider you choose — see docs/threat-model.md.
   */
  app.post("/v1/tenants/:tenantId/uploads/:mediaId/complete", async (req) => {
    const { mediaId } = parse(z.object({ tenantId: uuid, mediaId: uuid }), req.params);
    return app.inTenant(req, "media:upload", async (tx) => {
      const m = await getMedia(tx, mediaId);
      if (!m) throw notFound("upload");
      if (m.status !== "pending") return toMedia(m);
      const info = await app.deps.storage.head(m.storage_key);
      const mismatch = !info || info.byteSize !== Number(m.byte_size) || (info.contentType && info.contentType !== m.content_type);
      if (mismatch) {
        if (info) await app.deps.storage.delete(m.storage_key);
        await setMediaStatus(tx, m.id, "rejected");
        await app.audit(req, tx, { action: "media.rejected", targetType: "media_object", targetId: m.id, outcome: "failure" });
        throw new HttpError(422, "upload_mismatch", "uploaded object is missing or does not match the declared size/type");
      }
      await setMediaStatus(tx, m.id, "uploaded");
      await app.audit(req, tx, { action: "media.uploaded", targetType: "media_object", targetId: m.id });
      return toMedia({ ...m, status: "uploaded" });
    });
  });

  app.get("/v1/tenants/:tenantId/audit-events", async (req) => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    return app.inTenant(req, "audit:read", async (tx) => ({
      items: (await listAudit(tx, q.limit, q.before)).map((e) => ({
        id: String(e.id),
        actorUserId: e.actor_user_id,
        actorType: e.actor_type,
        action: e.action,
        targetType: e.target_type,
        targetId: e.target_id,
        outcome: e.outcome,
        requestId: e.request_id,
        metadata: e.metadata,
        createdAt: new Date(e.created_at).toISOString(),
      })),
    }));
  });
}
