import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createPendingMedia, getFarm, getMedia, listAudit, listFarmMedia, setMediaStatus } from "@metafarm/db";
import { createUploadSchema, uuid } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { toMedia } from "../lib/mappers";
import { buildStorageKey } from "@metafarm/storage";

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
      const t =
        env.UPLOAD_MODE === "proxy"
          ? {
              // The browser PUTs to the API (same bearer token); see the /content route below.
              url: `${req.protocol}://${req.host}/v1/tenants/${tenantId}/uploads/${m.id}/content`,
              method: "PUT" as const,
              headers: { "content-type": body.contentType },
              expiresAt: new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1000),
            }
          : await storage.presignPut(key, {
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
   * UPLOAD_MODE=proxy only: receives the file bytes for a pending upload and
   * writes them to storage. The body must match the declared content type,
   * size and SHA-256 exactly; the client then calls /complete as usual.
   */
  await app.register(async (scoped) => {
    const types = [...new Set(Object.values(ALLOWED).flat())];
    scoped.addContentTypeParser(types, { parseAs: "buffer", bodyLimit: app.deps.env.UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

    scoped.put("/v1/tenants/:tenantId/uploads/:mediaId/content", { bodyLimit: app.deps.env.UPLOAD_MAX_BYTES }, async (req, reply) => {
      if (app.deps.env.UPLOAD_MODE !== "proxy") throw notFound("route");
      const { mediaId } = parse(z.object({ tenantId: uuid, mediaId: uuid }), req.params);
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, "unsupported_media_type", "send the file bytes with its declared content type");
      const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

      const m = await app.inTenant(req, "media:upload", async (tx) => {
        const row = await getMedia(tx, mediaId);
        if (!row) throw notFound("upload");
        if (row.status !== "pending") throw new HttpError(409, "upload_not_pending", "this upload is no longer accepting content");
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (contentType !== row.content_type || body.length !== Number(row.byte_size) || sha256 !== row.sha256) {
          throw new HttpError(422, "upload_mismatch", "content does not match the declared type, size or SHA-256");
        }
        return row;
      });

      // Written outside the transaction so a slow storage call does not hold a database connection.
      await app.deps.storage.putObject(m.storage_key, body, m.content_type);
      return reply.status(204).send();
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

  app.get("/v1/tenants/:tenantId/farms/:farmId/media", async (req) => {
    const { farmId } = parse(z.object({ tenantId: uuid, farmId: uuid }), req.params);
    const { purpose } = parse(z.object({ purpose: z.enum(Object.keys(ALLOWED) as [string, ...string[]]).optional() }), req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      return { items: (await listFarmMedia(tx, farmId, purpose)).map((m) => ({ ...toMedia(m), uploadedBy: m.uploaded_by_name })) };
    });
  });

  /**
   * Streams a confirmed file to a member of its workspace. Files are served as
   * attachments except images and PDFs, and never sniffed, so an uploaded file
   * cannot run as a page on the API's origin.
   */
  app.get("/v1/tenants/:tenantId/media/:mediaId/content", async (req, reply) => {
    const { mediaId } = parse(z.object({ tenantId: uuid, mediaId: uuid }), req.params);
    const m = await app.inTenant(req, "farm:read", async (tx) => {
      const row = await getMedia(tx, mediaId);
      if (!row || row.status !== "uploaded") throw notFound("file");
      return row;
    });
    const obj = await app.deps.storage.getObject(m.storage_key);
    if (!obj) throw notFound("file");
    const inline = m.content_type.startsWith("image/") || m.content_type === "application/pdf";
    const safeName = m.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    return reply
      .header("content-type", m.content_type)
      .header("content-length", String(m.byte_size))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=300")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`)
      .send(obj.body);
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
