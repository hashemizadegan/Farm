import type { FastifyInstance } from "fastify";
import { getFarm, listHarvestsForExport, listInputItems, listMovements, listTasks } from "@metafarm/db";
import {
  EXPORT_COLUMNS,
  EXPORT_DATASETS,
  EXPORT_MAX_ROWS,
  exportFilename,
  exportQuerySchema,
  plainNumber,
  toCsv,
  toMilli,
  uuid,
  yesNo,
  type Cell,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const params = z.object({ tenantId: uuid, dataset: z.enum(EXPORT_DATASETS) });
const iso = (t: string | null) => (t ? new Date(t).toISOString() : "");

/**
 * CSV downloads of the farm's records: what was applied where (the spray / input log), harvests
 * with their fingerprints, tasks, and current stock. Anyone who can read the farm can export it.
 */
export async function exportRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/exports/:dataset", async (req, reply) => {
    const { dataset } = parse(params, req.params);
    const q = parse(exportQuerySchema, req.query);
    if (dataset === "stock" && (q.farmId || q.from || q.to)) throw new HttpError(400, "invalid_request", "stock is a snapshot of the whole workspace; it takes no farm or dates");
    const limit = EXPORT_MAX_ROWS + 1;

    const { csv, count } = await app.inTenant(req, "farm:read", async (tx) => {
      if (q.farmId && !(await getFarm(tx, q.farmId))) throw notFound("farm");
      let rows: Cell[][];
      if (dataset === "input-log") {
        const items = new Map((await listInputItems(tx, true)).map((i) => [i.id, i]));
        const moves = await listMovements(tx, { kind: "use", farmId: q.farmId, from: q.from, to: q.to, limit });
        rows = moves.reverse().map((m) => [
          m.occurred_on,
          m.farm_name,
          m.parcel_label,
          m.item_name,
          m.item_category,
          plainNumber(m.quantity, true),
          m.item_unit,
          m.lot,
          items.get(m.item_id)?.pre_harvest_interval_days,
          m.task_title,
          m.recorded_by_name,
          m.note,
        ]);
      } else if (dataset === "harvests") {
        rows = (await listHarvestsForExport(tx, { farmId: q.farmId, from: q.from, to: q.to, limit })).map((h) => [
          h.code,
          h.harvested_on,
          h.farm_name,
          h.crop_name,
          h.parcel_label,
          plainNumber(h.quantity),
          h.unit,
          h.quality_grade,
          h.recorded_by_name,
          h.record_hash,
          h.anchor_status,
          h.anchor_tx_hash,
          yesNo(q.lang, h.voided_at !== null),
          h.void_reason,
        ]);
      } else if (dataset === "tasks") {
        rows = (await listTasks(tx, { farmId: q.farmId, status: "all", from: q.from, to: q.to, limit })).map((t) => [
          t.due_date,
          t.farm_name,
          t.title,
          t.kind,
          t.parcel_label,
          t.priority,
          t.status,
          t.assignee_name,
          t.repeat_every_days,
          iso(t.completed_at),
          t.completed_by_name,
          t.completion_note,
        ]);
      } else {
        rows = (await listInputItems(tx, true)).map((i) => [
          i.name,
          i.category,
          i.unit,
          plainNumber(i.on_hand),
          plainNumber(i.reorder_level),
          yesNo(q.lang, i.reorder_level !== null && toMilli(i.on_hand) <= toMilli(i.reorder_level)),
          i.pre_harvest_interval_days,
          i.re_entry_hours,
          i.last_movement_on,
          yesNo(q.lang, i.archived_at !== null),
        ]);
      }
      if (rows.length > EXPORT_MAX_ROWS) throw new HttpError(413, "export_too_large", `more than ${EXPORT_MAX_ROWS} rows; choose a shorter date range`);
      await app.audit(req, tx, { action: "export.downloaded", targetType: "export", metadata: { dataset, farmId: q.farmId ?? null, from: q.from ?? null, to: q.to ?? null, rows: rows.length } });
      return { csv: toCsv(EXPORT_COLUMNS[q.lang][dataset], rows), count: rows.length };
    });

    const name = exportFilename(dataset, q, new Date().toISOString().slice(0, 10));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store")
      .header("x-row-count", String(count))
      .send(csv);
  });
}
