/**
 * Policy and configuration records (calculation policy, settlement units, quorum, storage, disclosures)
 * carry a status. Plan revision 4, §2.1 and §12.1:
 *
 * - a real (non-simulation) cycle may use only `approved` records;
 * - a simulation cycle may use only `simulation` records;
 * - a `draft` record is usable by neither.
 *
 * So a placeholder can never silently become policy for a real cycle.
 */

export const YIELD_RECORD_STATUSES = ["draft", "approved", "simulation"] as const;
export type YieldRecordStatus = (typeof YIELD_RECORD_STATUSES)[number];

export class YieldRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YieldRecordError";
  }
}

export function yieldRecordUsable(cycle: { simulation: boolean }, status: YieldRecordStatus): boolean {
  if (typeof cycle?.simulation !== "boolean") return false;
  return cycle.simulation ? status === "simulation" : status === "approved";
}

export function assertYieldRecordUsable(cycle: { simulation: boolean }, record: { status: YieldRecordStatus; kind: string }): void {
  if (!yieldRecordUsable(cycle, record.status)) {
    const who = cycle?.simulation ? "a simulation cycle" : "a real cycle";
    throw new YieldRecordError(`${who} cannot use a ${record.status} ${record.kind} record`);
  }
}
