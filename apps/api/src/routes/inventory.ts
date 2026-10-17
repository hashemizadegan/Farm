import type { FastifyInstance } from "fastify";
import {
  getFarm,
  getInputItem,
  getMovement,
  getTask,
  insertInputItem,
  insertMovement,
  latestApplicationsWithPhi,
  listInputItems,
  listMovements,
  updateInputItem,
  type InputItemRow,
  type MovementRow,
  type TenantTx,
} from "@metafarm/db";
import {
  MOVEMENT_KINDS,
  createInputItemSchema,
  harvestAllowedFrom,
  movementSchema,
  taskDateSchema,
  toMilli,
  updateInputItemSchema,
  uuid,
  withinPreHarvestInterval,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: uuid });

export const toInputItem = (i: InputItemRow) => ({
  id: i.id,
  name: i.name,
  category: i.category,
  unit: i.unit,
  reorderLevel: i.reorder_level === null ? null : trim(i.reorder_level),
  preHarvestIntervalDays: i.pre_harvest_interval_days,
  reEntryHours: i.re_entry_hours,
  notes: i.notes,
  archived: i.archived_at !== null,
  onHand: trim(i.on_hand),
  lowStock: i.reorder_level !== null && toMilli(i.on_hand) <= toMilli(i.reorder_level),
  lastMovementOn: i.last_movement_on,
  createdAt: new Date(i.created_at).toISOString(),
});

export const toMovement = (m: MovementRow) => ({
  id: m.id,
  itemId: m.item_id,
  itemName: m.item_name,
  itemUnit: m.item_unit,
  itemCategory: m.item_category,
  kind: m.kind,
  quantity: trim(m.quantity),
  occurredOn: m.occurred_on,
  farmId: m.farm_id,
  farmName: m.farm_name,
  parcelLabel: m.parcel_label,
  taskId: m.task_id,
  taskTitle: m.task_title,
  supplier: m.supplier,
  lot: m.lot,
  expiresOn: m.expires_on,
  cost: m.cost,
  currency: m.currency,
  note: m.note,
  recordedByName: m.recorded_by_name,
  createdAt: new Date(m.created_at).toISOString(),
});

/** "12.500" → "12.5", "-3.000" → "-3". */
function trim(n: string): string {
  return n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n;
}

/** Records one "use" of an input on a farm (also used when completing a task). */
export async function recordUse(
  tx: TenantTx,
  u: { itemId: string; quantity: string; occurredOn: string; farmId: string; parcelLabel?: string | null; taskId?: string | null; note?: string | null; userId: string },
) {
  const item = await getInputItem(tx, u.itemId);
  if (!item) throw new HttpError(400, "invalid_item", "unknown input item");
  if (item.archived_at) throw new HttpError(409, "item_archived", `${item.name} is archived`);
  return insertMovement(tx, { ...u, kind: "use", quantity: `-${u.quantity}` });
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/inventory/items", async (req) => {
    parse(tenantParams, req.params);
    const q = parse(z.object({ includeArchived: z.enum(["true", "false"]).optional() }), req.query);
    return app.inTenant(req, "farm:read", async (tx) => ({ items: (await listInputItems(tx, q.includeArchived === "true")).map(toInputItem) }));
  });

  app.post("/v1/tenants/:tenantId/inventory/items", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createInputItemSchema, req.body);
    const item = await app.inTenant(req, "inventory:manage", async (tx) => {
      try {
        await tx.query("SAVEPOINT item");
        const id = await insertInputItem(tx, body, req.user!.id);
        await app.audit(req, tx, { action: "input_item.created", targetType: "input_item", targetId: id, metadata: { category: body.category } });
        return (await getInputItem(tx, id))!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_item", "an input with this name already exists");
        throw err;
      }
    });
    return reply.status(201).send(toInputItem(item));
  });

  app.patch("/v1/tenants/:tenantId/inventory/items/:itemId", async (req) => {
    const { itemId } = parse(tenantParams.extend({ itemId: uuid }), req.params);
    const body = parse(updateInputItemSchema, req.body);
    return app.inTenant(req, "inventory:manage", async (tx) => {
      if (!(await getInputItem(tx, itemId))) throw notFound("input item");
      try {
        await updateInputItem(tx, itemId, body);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_item", "an input with this name already exists");
        throw err;
      }
      await app.audit(req, tx, { action: "input_item.updated", targetType: "input_item", targetId: itemId, metadata: { fields: Object.keys(body) } });
      return toInputItem((await getInputItem(tx, itemId))!);
    });
  });

  app.get("/v1/tenants/:tenantId/inventory/movements", async (req) => {
    parse(tenantParams, req.params);
    const q = parse(
      z.object({
        itemId: uuid.optional(),
        farmId: uuid.optional(),
        kind: z.enum(MOVEMENT_KINDS).optional(),
        from: taskDateSchema.optional(),
        to: taskDateSchema.optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      }),
      req.query,
    );
    return app.inTenant(req, "farm:read", async (tx) => ({ items: (await listMovements(tx, q)).map(toMovement) }));
  });

  app.post("/v1/tenants/:tenantId/inventory/movements", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(movementSchema, req.body);
    // Deliveries and stock corrections are a manager's job; anyone doing field work records what they used.
    const permission = body.kind === "use" ? "inventory:use" : "inventory:manage";
    const out = await app.inTenant(req, permission, async (tx) => {
      let id: string;
      if (body.kind === "use") {
        const farm = await getFarm(tx, body.farmId);
        if (!farm) throw new HttpError(400, "invalid_farm", "unknown farm");
        if (body.taskId && !(await getTask(tx, body.farmId, body.taskId))) throw new HttpError(400, "invalid_task", "the task must belong to this farm");
        id = await recordUse(tx, { ...body, userId: req.user!.id });
      } else {
        const item = await getInputItem(tx, body.itemId);
        if (!item) throw new HttpError(400, "invalid_item", "unknown input item");
        if (body.kind === "receive" && (body.cost == null) !== (body.currency == null)) {
          throw new HttpError(400, "invalid_cost", "give both a cost and its currency, or neither");
        }
        id = await insertMovement(tx, { ...body, userId: req.user!.id });
      }
      await app.audit(req, tx, { action: `stock.${body.kind}`, targetType: "stock_movement", targetId: id, metadata: { itemId: body.itemId } });
      return { movement: toMovement((await getMovement(tx, id))!), item: toInputItem((await getInputItem(tx, body.itemId))!) };
    });
    return reply.status(201).send(out);
  });

  // Pre-harvest intervals still running on a parcel: what blocks a harvest on a given day.
  app.get("/v1/tenants/:tenantId/farms/:farmId/phi", async (req) => {
    const { farmId } = parse(tenantParams.extend({ farmId: uuid }), req.params);
    const q = parse(z.object({ parcel: z.string().trim().max(80).optional(), on: taskDateSchema }), req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      const rows = await latestApplicationsWithPhi(tx, farmId, q.parcel || null);
      return {
        items: rows
          .filter((r) => withinPreHarvestInterval(r.applied_on, r.pre_harvest_interval_days, q.on))
          .map((r) => ({
            itemId: r.item_id,
            itemName: r.item_name,
            parcelLabel: r.parcel_label,
            appliedOn: r.applied_on,
            preHarvestIntervalDays: r.pre_harvest_interval_days,
            harvestAllowedFrom: harvestAllowedFrom(r.applied_on, r.pre_harvest_interval_days),
          })),
      };
    });
  });
}
