import type { FastifyInstance } from "fastify";
import {
  archivePlan,
  getEquipment,
  getFarm,
  getMemberRole,
  getPlan,
  getTask,
  insertEquipment,
  insertPlan,
  insertReading,
  insertService,
  insertTask,
  listEquipment,
  listPlans,
  listReadings,
  listServices,
  updateEquipment,
  type EquipmentRow,
  type PlanRow,
  type TenantTx,
} from "@metafarm/db";
import {
  createEquipmentSchema,
  dayInZone,
  maintenanceDue,
  maintenancePlanSchema,
  meterReadingSchema,
  serviceRecordSchema,
  updateEquipmentSchema,
  uuid,
  type DueState,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { toTask } from "./tasks";

const tenantParams = z.object({ tenantId: uuid });
const eqParams = tenantParams.extend({ equipmentId: uuid });
const planParams = eqParams.extend({ planId: uuid });

const num = (v: string | null) => (v === null ? null : Number(v));

const toEquipment = (e: EquipmentRow) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  makeModel: e.make_model,
  serial: e.serial,
  farmId: e.farm_id,
  farmName: e.farm_name,
  tracksHours: e.tracks_hours,
  status: e.status,
  statusNote: e.status_note,
  notes: e.notes,
  currentHours: e.current_hours === null ? null : String(Number(e.current_hours)),
  currentHoursOn: e.current_hours_on,
  createdAt: new Date(e.created_at).toISOString(),
});

function planWithDue(p: PlanRow, e: EquipmentRow, today: string) {
  const due = maintenanceDue(
    { everyHours: p.every_hours, everyDays: p.every_days, lastDoneOn: p.last_done_on, lastDoneHours: num(p.last_done_hours) },
    { today, hours: num(e.current_hours) },
  );
  return {
    id: p.id,
    title: p.title,
    everyHours: p.every_hours,
    everyDays: p.every_days,
    lastDoneOn: p.last_done_on,
    lastDoneHours: p.last_done_hours === null ? null : String(Number(p.last_done_hours)),
    notes: p.notes,
    due: { state: due.state, dueOn: due.dueOn, dueHours: due.dueHours },
  };
}

async function todayFor(tx: TenantTx, e: EquipmentRow, now: Date): Promise<string> {
  const farm = e.farm_id ? await getFarm(tx, e.farm_id) : undefined;
  return dayInZone(now, farm?.timezone ?? "UTC");
}

const RANK: Record<DueState, number> = { overdue: 0, soon: 1, ok: 2 };

export async function equipmentRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/equipment", async (req) => {
    parse(tenantParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const [items, plans] = await Promise.all([listEquipment(tx), listPlans(tx)]);
      const today = dayInZone(app.deps.now(), "UTC");
      return {
        items: items.map((e) => {
          const due = plans.filter((p) => p.equipment_id === e.id).map((p) => planWithDue(p, e, today).due);
          const worst = due.sort((a, b) => RANK[a.state] - RANK[b.state])[0];
          return {
            ...toEquipment(e),
            maintenance: {
              overdue: due.filter((d) => d.state === "overdue").length,
              soon: due.filter((d) => d.state === "soon").length,
              state: e.status === "retired" ? "ok" : (worst?.state ?? "ok"),
            },
          };
        }),
      };
    });
  });

  app.post("/v1/tenants/:tenantId/equipment", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createEquipmentSchema, req.body);
    const e = await app.inTenant(req, "equipment:manage", async (tx) => {
      if (body.farmId && !(await getFarm(tx, body.farmId))) throw new HttpError(400, "invalid_farm", "unknown farm");
      try {
        await tx.query("SAVEPOINT eq");
        const id = await insertEquipment(tx, body, req.user!.id);
        if (body.tracksHours && body.currentHours) {
          await insertReading(tx, id, { hours: body.currentHours, readOn: dayInZone(app.deps.now(), "UTC"), userId: req.user!.id });
        }
        await app.audit(req, tx, { action: "equipment.created", targetType: "equipment", targetId: id, metadata: { kind: body.kind } });
        return (await getEquipment(tx, id))!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_equipment", "a machine with this name already exists");
        throw err;
      }
    });
    return reply.status(201).send(toEquipment(e));
  });

  app.get("/v1/tenants/:tenantId/equipment/:equipmentId", async (req) => {
    const { equipmentId } = parse(eqParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const e = await getEquipment(tx, equipmentId);
      if (!e) throw notFound("equipment");
      const today = await todayFor(tx, e, app.deps.now());
      const [plans, readings, services] = await Promise.all([listPlans(tx, equipmentId), listReadings(tx, equipmentId), listServices(tx, equipmentId)]);
      return {
        equipment: toEquipment(e),
        today,
        plans: plans.map((p) => planWithDue(p, e, today)).sort((a, b) => RANK[a.due.state] - RANK[b.due.state]),
        readings: readings.map((r) => ({ id: r.id, hours: String(Number(r.hours)), readOn: r.read_on, note: r.note, recordedByName: r.recorded_by_name })),
        services: services.map((s) => ({
          id: s.id,
          planTitle: s.plan_title,
          doneOn: s.done_on,
          hours: s.hours === null ? null : String(Number(s.hours)),
          description: s.description,
          cost: s.cost,
          currency: s.currency,
          recordedByName: s.recorded_by_name,
        })),
      };
    });
  });

  app.patch("/v1/tenants/:tenantId/equipment/:equipmentId", async (req) => {
    const { equipmentId } = parse(eqParams, req.params);
    const body = parse(updateEquipmentSchema, req.body);
    return app.inTenant(req, "equipment:manage", async (tx) => {
      if (!(await getEquipment(tx, equipmentId))) throw notFound("equipment");
      if (body.farmId && !(await getFarm(tx, body.farmId))) throw new HttpError(400, "invalid_farm", "unknown farm");
      const change = { ...body };
      if (change.status === "active") change.statusNote = change.statusNote ?? null;
      try {
        await updateEquipment(tx, equipmentId, change);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_equipment", "a machine with this name already exists");
        throw err;
      }
      await app.audit(req, tx, { action: "equipment.updated", targetType: "equipment", targetId: equipmentId, metadata: { fields: Object.keys(change) } });
      return toEquipment((await getEquipment(tx, equipmentId))!);
    });
  });

  app.post("/v1/tenants/:tenantId/equipment/:equipmentId/readings", async (req, reply) => {
    const { equipmentId } = parse(eqParams, req.params);
    const body = parse(meterReadingSchema, req.body);
    const e = await app.inTenant(req, "equipment:use", async (tx) => {
      const e = await getEquipment(tx, equipmentId);
      if (!e) throw notFound("equipment");
      if (!e.tracks_hours) throw new HttpError(409, "no_hour_meter", "this machine does not track running hours");
      // Hour meters only go up; a lower reading is almost always a typing mistake.
      if (e.current_hours !== null && Number(body.hours) < Number(e.current_hours)) {
        throw new HttpError(409, "reading_lower", `the meter already reads ${Number(e.current_hours)} h`);
      }
      await insertReading(tx, equipmentId, { ...body, userId: req.user!.id });
      return (await getEquipment(tx, equipmentId))!;
    });
    return reply.status(201).send(toEquipment(e));
  });

  app.post("/v1/tenants/:tenantId/equipment/:equipmentId/plans", async (req, reply) => {
    const { equipmentId } = parse(eqParams, req.params);
    const body = parse(maintenancePlanSchema, req.body);
    const out = await app.inTenant(req, "equipment:manage", async (tx) => {
      const e = await getEquipment(tx, equipmentId);
      if (!e) throw notFound("equipment");
      if (body.everyHours && !e.tracks_hours) throw new HttpError(400, "no_hour_meter", "turn on hour tracking for this machine to plan by hours");
      const id = await insertPlan(tx, equipmentId, body);
      await app.audit(req, tx, { action: "maintenance_plan.created", targetType: "maintenance_plan", targetId: id, metadata: { equipmentId } });
      return planWithDue((await getPlan(tx, equipmentId, id))!, e, await todayFor(tx, e, app.deps.now()));
    });
    return reply.status(201).send(out);
  });

  app.post("/v1/tenants/:tenantId/equipment/:equipmentId/plans/:planId/archive", async (req) => {
    const { equipmentId, planId } = parse(planParams, req.params);
    return app.inTenant(req, "equipment:manage", async (tx) => {
      if (!(await getPlan(tx, equipmentId, planId))) throw notFound("maintenance plan");
      await archivePlan(tx, equipmentId, planId);
      await app.audit(req, tx, { action: "maintenance_plan.archived", targetType: "maintenance_plan", targetId: planId, metadata: { equipmentId } });
      return { archived: true };
    });
  });

  app.post("/v1/tenants/:tenantId/equipment/:equipmentId/services", async (req, reply) => {
    const { equipmentId } = parse(eqParams, req.params);
    const body = parse(serviceRecordSchema, req.body);
    const e = await app.inTenant(req, "equipment:use", async (tx) => {
      const e = await getEquipment(tx, equipmentId);
      if (!e) throw notFound("equipment");
      if (body.planId && !(await getPlan(tx, equipmentId, body.planId))) throw new HttpError(400, "invalid_plan", "unknown maintenance plan");
      await insertService(tx, equipmentId, { ...body, userId: req.user!.id });
      // A meter value noted at service time is also a reading, if it moves the meter forward.
      if (e.tracks_hours && body.hours && (e.current_hours === null || Number(body.hours) > Number(e.current_hours))) {
        await insertReading(tx, equipmentId, { hours: body.hours, readOn: body.doneOn, note: body.description.slice(0, 120), userId: req.user!.id });
      }
      await app.audit(req, tx, { action: "equipment.serviced", targetType: "equipment", targetId: equipmentId, metadata: { planId: body.planId ?? null } });
      return (await getEquipment(tx, equipmentId))!;
    });
    return reply.status(201).send(toEquipment(e));
  });

  // Turn due maintenance into a task for the team, on the machine's farm.
  app.post("/v1/tenants/:tenantId/equipment/:equipmentId/plans/:planId/task", async (req, reply) => {
    const { equipmentId, planId } = parse(planParams, req.params);
    const body = parse(z.object({ assigneeUserId: uuid.nullable().optional() }).strict(), req.body ?? {});
    const task = await app.inTenant(req, "task:manage", async (tx) => {
      const e = await getEquipment(tx, equipmentId);
      const p = e ? await getPlan(tx, equipmentId, planId) : undefined;
      if (!e || !p) throw notFound("maintenance plan");
      if (!e.farm_id) throw new HttpError(409, "no_farm", "assign the machine to a farm first");
      if (body.assigneeUserId && !(await getMemberRole(tx, body.assigneeUserId))) {
        throw new HttpError(400, "invalid_assignee", "the assignee must be a member of this workspace");
      }
      const today = await todayFor(tx, e, app.deps.now());
      const due = planWithDue(p, e, today).due;
      // Overdue (by hours or days) means now; otherwise the calendar due day, when there is one.
      const dueDate = due.state !== "overdue" && due.dueOn && due.dueOn > today ? due.dueOn : today;
      const id = await insertTask(
        tx,
        e.farm_id,
        {
          title: `${p.title}: ${e.name}`.slice(0, 160),
          kind: "maintenance",
          dueDate,
          priority: due.state === "overdue" ? "high" : "normal",
          assigneeUserId: body.assigneeUserId ?? null,
          notes: p.notes,
        },
        req.user!.id,
      );
      await app.audit(req, tx, { action: "task.created", targetType: "farm_task", targetId: id, metadata: { farmId: e.farm_id, equipmentId, planId } });
      return (await getTask(tx, e.farm_id, id))!;
    });
    return reply.status(201).send(toTask(task));
  });
}
