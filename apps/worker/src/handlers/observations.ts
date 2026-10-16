import { getRawObservation, insertObservation, markRawObservation, withTenant, type Pool } from "@metafarm/db";
import { NonRetryableJobError, ObservationError, normaliseObservation, type ObservationNormalizationJob, type RawObservation } from "@metafarm/domain";
import type { Handler } from "../runner";

/**
 * Normalises a raw observation into canonical units. Unknown metrics or units
 * are rejected permanently (no guessing). Re-running for the same raw row is a
 * no-op thanks to the unique raw_id constraint.
 */
export function observationNormalizationHandler(pool: Pool, now: () => Date = () => new Date()): Handler<ObservationNormalizationJob> {
  return async (job, { log }) =>
    withTenant(pool, job.tenantId, async (tx) => {
      const raw = await getRawObservation(tx, job.rawObservationId);
      if (!raw) throw new NonRetryableJobError("raw observation not found");
      if (raw.status === "rejected") return { status: "rejected" };
      const p = raw.payload as Partial<RawObservation>;
      try {
        const o = normaliseObservation(
          {
            metric: String(p.metric),
            value: p.value as number | string,
            unit: String(p.unit),
            observedAt: String(p.observedAt),
            provenance: raw.provenance_label,
          },
          now(),
        );
        const { id, inserted } = await insertObservation(tx, raw.farm_id, raw.id, raw.sensor_id, o);
        await markRawObservation(tx, raw.id, "normalized");
        log.info({ observationId: id, inserted, flags: o.qualityFlags }, "observation normalised");
        return { observationId: id, inserted };
      } catch (err) {
        if (err instanceof ObservationError) {
          await markRawObservation(tx, raw.id, "rejected", err.message);
          // A rejection is a terminal outcome recorded on the raw row, not a retryable failure.
          return { status: "rejected", reason: err.message };
        }
        throw err;
      }
    });
}
