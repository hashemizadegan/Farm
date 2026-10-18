/** Turning what a chain reports into lifecycle steps. */
import type { OperationState } from "./lifecycle";
import type { ChainObservation } from "./ports";

/**
 * The steps to record after an observation, in order (empty when nothing changed). A transaction
 * seen final while we still had it as submitted passes through observed first, so the log reads
 * the same whichever poll caught it.
 */
export function stepsAfterObservation(current: OperationState, o: ChainObservation): OperationState[] {
  switch (current) {
    case "prepared":
      // Crashed between preparing and recording the send; the chain decides.
      if (o.status === "expired") return ["expired"];
      if (o.status === "not_found" || o.status === "pending") return [];
      return ["submitted", ...stepsAfterObservation("submitted", o)];
    case "submitted":
      if (o.status === "observed") return ["observed"];
      if (o.status === "final") return ["observed", "confirmed"];
      if (o.status === "failed") return ["failed"];
      if (o.status === "expired") return ["expired"];
      return [];
    case "observed":
      if (o.status === "final") return ["confirmed"];
      if (o.status === "failed") return ["failed"];
      // Seen at a lower commitment, then gone past its validity: dropped by a fork.
      if (o.status === "expired") return ["expired"];
      return [];
    default:
      return [];
  }
}
