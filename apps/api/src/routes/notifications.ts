import type { FastifyInstance } from "fastify";
import { listNotifications, markNotificationsRead } from "@metafarm/db";
import { uuid } from "@metafarm/domain";
import { z } from "zod";
import { parse } from "../lib/http";

/** Each member sees only their own notifications. */
export async function notificationRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/notifications", async (req) => {
    parse(z.object({ tenantId: uuid }), req.params);
    const q = parse(z.object({ unread: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      const r = await listNotifications(tx, req.user!.id, q.unread === "true", q.limit);
      return {
        unread: r.unread,
        items: r.items.map((n) => ({ id: n.id, kind: n.kind, data: n.data, read: n.read_at !== null, createdAt: new Date(n.created_at).toISOString() })),
      };
    });
  });

  app.post("/v1/tenants/:tenantId/notifications/read", async (req) => {
    parse(z.object({ tenantId: uuid }), req.params);
    const body = parse(z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(uuid).min(1).max(200) }).strict()]), req.body);
    return app.inTenant(req, "farm:read", async (tx) => ({ marked: await markNotificationsRead(tx, req.user!.id, "all" in body ? "all" : body.ids) }));
  });
}
