import type { FastifyInstance } from "fastify";
import { findNextOccurrence, getFarm, getMedia, getMemberRole, getTask, insertTask, listTasks, markTaskDone, notify, updateTask, type TaskRow, type TenantTx } from "@metafarm/db";
import {
  can,
  completeTaskSchema,
  createTaskSchema,
  dayInZone,
  isWorkerOnlyUpdate,
  nextOccurrence,
  taskDateSchema,
  updateTaskSchema,
  uuid,
  type Role,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, forbidden, idempotencyKey, notFound, parse } from "../lib/http";
import { recordUse } from "./inventory";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });
const taskParams = farmParams.extend({ taskId: uuid });

const listQuery = z.object({
  status: z.enum(["open", "done", "cancelled", "all"]).default("open"),
  assignee: z.union([z.literal("me"), uuid]).optional(),
  from: taskDateSchema.optional(),
  to: taskDateSchema.optional(),
  includeOverdue: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const toTask = (t: TaskRow) => ({
  id: t.id,
  farmId: t.farm_id,
  farmName: t.farm_name,
  title: t.title,
  kind: t.kind,
  parcelLabel: t.parcel_label,
  assigneeUserId: t.assignee_user_id,
  assigneeName: t.assignee_name,
  dueDate: t.due_date,
  priority: t.priority,
  status: t.status,
  notes: t.notes,
  repeatEveryDays: t.repeat_every_days,
  previousTaskId: t.previous_task_id,
  completionNote: t.completion_note,
  completionMediaIds: t.completion_media_ids,
  completedAt: t.completed_at ? new Date(t.completed_at).toISOString() : null,
  completedByName: t.completed_by_name,
  createdAt: new Date(t.created_at).toISOString(),
  updatedAt: new Date(t.updated_at).toISOString(),
});

async function assertAssignable(tx: TenantTx, userId: string | null | undefined) {
  if (userId && !(await getMemberRole(tx, userId))) {
    throw new HttpError(400, "invalid_assignee", "the assignee must be a member of this workspace");
  }
}

/** Tells a person a task was given to them (not when they gave it to themselves). */
export async function notifyAssignee(tx: TenantTx, t: TaskRow, byUserId: string) {
  if (!t.assignee_user_id || t.assignee_user_id === byUserId) return;
  await notify(
    tx,
    [t.assignee_user_id],
    "task_assigned",
    { taskId: t.id, farmId: t.farm_id, farmName: t.farm_name, title: t.title, dueDate: t.due_date },
    `task:${t.id}:${t.assignee_user_id}`,
  );
}

/** Workers may act on tasks assigned to them, or on unassigned tasks (which they then take). */
function mayWork(role: Role, userId: string, task: TaskRow) {
  if (can(role, "task:manage")) return true;
  return can(role, "task:work") && (task.assignee_user_id === null || task.assignee_user_id === userId);
}

export async function taskRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/farms/:farmId/tasks", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const q = parse(listQuery, req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      const rows = await listTasks(tx, {
        farmId,
        status: q.status,
        assigneeUserId: q.assignee === "me" ? req.user!.id : q.assignee,
        from: q.from,
        to: q.to,
        includeOverdue: q.includeOverdue === "true",
        limit: q.limit,
      });
      return { items: rows.map(toTask) };
    });
  });

  // Across all farms: "my tasks" and the team's weekly schedule.
  app.get("/v1/tenants/:tenantId/tasks", async (req) => {
    parse(z.object({ tenantId: uuid }), req.params);
    const q = parse(listQuery, req.query);
    if (q.from && q.to && (q.to < q.from || Date.parse(q.to) - Date.parse(q.from) > 92 * 86_400_000)) {
      throw new HttpError(400, "invalid_range", "the date range must be at most 92 days, with from before to");
    }
    return app.inTenant(req, "farm:read", async (tx) => {
      const rows = await listTasks(tx, {
        status: q.status,
        assigneeUserId: q.assignee === "me" ? req.user!.id : q.assignee,
        from: q.from,
        to: q.to,
        includeOverdue: q.includeOverdue === "true",
        limit: q.limit,
      });
      return { items: rows.map(toTask) };
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/tasks", async (req, reply) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(createTaskSchema, req.body);
    const task = await app.inTenant(req, "task:manage", async (tx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      if (farm.archived_at) throw new HttpError(409, "farm_archived", "restore the farm before adding tasks");
      await assertAssignable(tx, body.assigneeUserId);
      const id = await insertTask(tx, farmId, body, req.user!.id);
      await app.audit(req, tx, { action: "task.created", targetType: "farm_task", targetId: id, metadata: { farmId, kind: body.kind } });
      const created = (await getTask(tx, farmId, id))!;
      await notifyAssignee(tx, created, req.user!.id);
      return created;
    });
    return reply.status(201).send(toTask(task));
  });

  app.patch("/v1/tenants/:tenantId/farms/:farmId/tasks/:taskId", async (req) => {
    const { farmId, taskId } = parse(taskParams, req.params);
    const body = parse(updateTaskSchema, req.body);
    return app.inTenant(req, "task:work", async (tx, ctx) => {
      const task = await getTask(tx, farmId, taskId, true);
      if (!task) throw notFound("task");
      const manager = can(ctx.role, "task:manage");
      if (!manager && (!isWorkerOnlyUpdate(body) || !mayWork(ctx.role, req.user!.id, task))) throw forbidden();
      if (task.status === "done") throw new HttpError(409, "task_done", "a completed task cannot be changed");
      if ("assigneeUserId" in body) await assertAssignable(tx, body.assigneeUserId);
      // A worker who starts an unassigned task takes it.
      const change = !manager && task.assignee_user_id === null ? { ...body, assigneeUserId: req.user!.id } : body;
      await updateTask(tx, farmId, taskId, change);
      await app.audit(req, tx, { action: "task.updated", targetType: "farm_task", targetId: taskId, metadata: { farmId, fields: Object.keys(change) } });
      const updated = (await getTask(tx, farmId, taskId))!;
      if (updated.assignee_user_id !== task.assignee_user_id) await notifyAssignee(tx, updated, req.user!.id);
      return toTask(updated);
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/tasks/:taskId/complete", { config: { idempotency: "handler" } }, async (req) => {
    const { farmId, taskId } = parse(taskParams, req.params);
    const body = parse(completeTaskSchema, req.body ?? {});
    const key = idempotencyKey(req);
    return app.inTenant(req, "task:work", async (tx, ctx) => {
      const task = await getTask(tx, farmId, taskId, true);
      if (!task) throw notFound("task");
      if (!mayWork(ctx.role, req.user!.id, task)) throw forbidden();
      // A resend of this same completion (offline queue): answer as the first time did.
      if (task.status === "done" && key && task.completion_request_id === key) {
        const next = await findNextOccurrence(tx, farmId, taskId);
        return { task: toTask(task), next: next ? toTask(next) : null };
      }
      if (task.status === "done") throw new HttpError(409, "task_done", "this task is already completed");
      if (task.status === "cancelled") throw new HttpError(409, "task_cancelled", "reopen the task before completing it");
      for (const id of new Set(body.mediaIds)) {
        const m = await getMedia(tx, id);
        if (!m || m.farm_id !== farmId || m.status !== "uploaded") {
          throw new HttpError(400, "invalid_media", "photos must be uploaded files of this farm");
        }
      }
      await markTaskDone(tx, farmId, taskId, { note: body.note, mediaIds: [...new Set(body.mediaIds)], userId: req.user!.id, requestId: key });
      if (body.inputs.length && !can(ctx.role, "inventory:use")) throw forbidden();
      const today = dayInZone(app.deps.now(), task.farm_timezone);
      for (const input of body.inputs) {
        await recordUse(tx, { ...input, occurredOn: today, farmId, parcelLabel: task.parcel_label, taskId, userId: req.user!.id });
      }

      let nextId: string | undefined;
      if (task.repeat_every_days) {
        nextId = await insertTask(
          tx,
          farmId,
          {
            title: task.title,
            kind: task.kind,
            parcelLabel: task.parcel_label,
            assigneeUserId: task.assignee_user_id ?? req.user!.id,
            dueDate: nextOccurrence(task.due_date, task.repeat_every_days, today),
            priority: task.priority,
            notes: task.notes,
            repeatEveryDays: task.repeat_every_days,
            previousTaskId: task.id,
          },
          req.user!.id,
        );
      }
      await app.audit(req, tx, {
        action: "task.completed",
        targetType: "farm_task",
        targetId: taskId,
        metadata: { farmId, photos: body.mediaIds.length, inputs: body.inputs.length, nextTaskId: nextId ?? null },
      });
      return {
        task: toTask((await getTask(tx, farmId, taskId))!),
        next: nextId ? toTask((await getTask(tx, farmId, nextId))!) : null,
      };
    });
  });
}
