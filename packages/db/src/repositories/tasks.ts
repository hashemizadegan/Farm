import type { CreateTaskInput, TaskKind, TaskPriority, TaskStatus, UpdateTaskInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface TaskRow {
  id: string;
  farm_id: string;
  farm_name: string;
  farm_timezone: string;
  title: string;
  kind: TaskKind;
  parcel_label: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  due_date: string;
  priority: TaskPriority;
  status: TaskStatus;
  notes: string | null;
  repeat_every_days: number | null;
  previous_task_id: string | null;
  completion_note: string | null;
  completion_media_ids: string[];
  completed_at: string | null;
  completed_by: string | null;
  completed_by_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Dates go out as text: node-postgres would otherwise turn a `date` into a local-time Date and shift the day.
const SELECT = `
  SELECT t.id, t.farm_id, f.name AS farm_name, f.timezone AS farm_timezone, t.title, t.kind, t.parcel_label,
         t.assignee_user_id, coalesce(a.display_name, a.email::text) AS assignee_name,
         to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.priority, t.status, t.notes, t.repeat_every_days,
         t.previous_task_id, t.completion_note, t.completion_media_ids, t.completed_at, t.completed_by,
         coalesce(c.display_name, c.email::text) AS completed_by_name, t.created_by, t.created_at, t.updated_at
    FROM farm_tasks t
    JOIN farms f ON f.tenant_id = t.tenant_id AND f.id = t.farm_id
    LEFT JOIN users a ON a.id = t.assignee_user_id
    LEFT JOIN users c ON c.id = t.completed_by`;

export async function getTask(tx: TenantTx, farmId: string, taskId: string, forUpdate = false): Promise<TaskRow | undefined> {
  if (forUpdate) {
    // Lock the row first so concurrent completions are serialised.
    await tx.query(`SELECT 1 FROM farm_tasks WHERE tenant_id = $1 AND farm_id = $2 AND id = $3 FOR UPDATE`, [tx.tenantId, farmId, taskId]);
  }
  const r = await tx.query<TaskRow>(`${SELECT} WHERE t.tenant_id = $1 AND t.farm_id = $2 AND t.id = $3`, [tx.tenantId, farmId, taskId]);
  return r.rows[0];
}

export interface TaskFilter {
  farmId?: string;
  assigneeUserId?: string;
  /** open = todo + in_progress. */
  status: "open" | "done" | "cancelled" | "all";
  from?: string;
  to?: string;
  /** With a date range, also include open tasks due before `from`. */
  includeOverdue?: boolean;
  limit: number;
}

export async function listTasks(tx: TenantTx, f: TaskFilter): Promise<TaskRow[]> {
  const where = ["t.tenant_id = $1"];
  const params: unknown[] = [tx.tenantId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.farmId) add("t.farm_id = ?", f.farmId);
  if (f.assigneeUserId) add("t.assignee_user_id = ?", f.assigneeUserId);
  if (f.status === "open") where.push("t.status IN ('todo', 'in_progress')");
  else if (f.status !== "all") add("t.status = ?", f.status);
  if (f.to) add("t.due_date <= ?::date", f.to);
  if (f.from) {
    params.push(f.from);
    const p = `$${params.length}`;
    where.push(f.includeOverdue ? `(t.due_date >= ${p}::date OR t.status IN ('todo', 'in_progress'))` : `t.due_date >= ${p}::date`);
  }
  // Archived farms drop out of day-to-day lists.
  where.push("f.archived_at IS NULL");
  params.push(f.limit);
  const order = f.status === "done" ? "t.completed_at DESC" : "t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.created_at";
  const r = await tx.query<TaskRow>(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${params.length}`, params);
  return r.rows;
}

export async function insertTask(
  tx: TenantTx,
  farmId: string,
  input: CreateTaskInput & { previousTaskId?: string },
  userId: string,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO farm_tasks (tenant_id, farm_id, title, kind, parcel_label, assignee_user_id, due_date, priority, notes, repeat_every_days, previous_task_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      tx.tenantId,
      farmId,
      input.title,
      input.kind,
      input.parcelLabel || null,
      input.assigneeUserId ?? null,
      input.dueDate,
      input.priority,
      input.notes || null,
      input.repeatEveryDays ?? null,
      input.previousTaskId ?? null,
      userId,
    ],
  );
  return r.rows[0]!.id;
}

const COLUMNS: Record<keyof UpdateTaskInput, string> = {
  title: "title",
  kind: "kind",
  parcelLabel: "parcel_label",
  assigneeUserId: "assignee_user_id",
  dueDate: "due_date",
  priority: "priority",
  notes: "notes",
  repeatEveryDays: "repeat_every_days",
  status: "status",
};

export async function updateTask(tx: TenantTx, farmId: string, taskId: string, input: UpdateTaskInput): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tx.tenantId, farmId, taskId];
  for (const [k, v] of Object.entries(input) as [keyof UpdateTaskInput, unknown][]) {
    params.push(v === "" ? null : v);
    sets.push(`${COLUMNS[k]} = $${params.length}${k === "dueDate" ? "::date" : ""}`);
  }
  await tx.query(`UPDATE farm_tasks SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND farm_id = $2 AND id = $3`, params);
}

export async function markTaskDone(tx: TenantTx, farmId: string, taskId: string, input: { note?: string; mediaIds: string[]; userId: string }) {
  await tx.query(
    `UPDATE farm_tasks
        SET status = 'done', completed_at = now(), completed_by = $4, completion_note = $5, completion_media_ids = $6::uuid[], updated_at = now()
      WHERE tenant_id = $1 AND farm_id = $2 AND id = $3`,
    [tx.tenantId, farmId, taskId, input.userId, input.note || null, input.mediaIds],
  );
}
