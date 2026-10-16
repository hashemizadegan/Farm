/**
 * Provenance labels describe where a piece of data came from. They are shown
 * next to every boundary, observation, scene element and NFT metadata record.
 *
 * Rules:
 * - Anything a customer typed, drew or uploaded is `user-entered`.
 * - Anything generated for display only (3D plants, placeholder textures,
 *   simulated scenarios) is `illustrative`.
 * - Data delivered by an external data provider integration is `provider-observation`.
 * - Data pushed by a registered sensor is `sensor-reported`.
 * - `independently-verified` may only be assigned when at least one evidence
 *   record exists and a reviewer with the `verifier` role attached it.
 */
export const PROVENANCE_LABELS = [
  "illustrative",
  "user-entered",
  "provider-observation",
  "sensor-reported",
  "independently-verified",
] as const;

export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

export interface VerificationEvidence {
  id: string;
  kind: "survey-document" | "registry-extract" | "field-inspection" | "other";
  mediaObjectId: string;
  reviewerUserId: string;
  reviewedAt: string;
  note?: string;
}

export interface Provenance {
  label: ProvenanceLabel;
  /** ISO-8601 timestamp of when the source produced the value, not when we stored it. */
  sourceTimestamp: string;
  /** Free-form source identifier: user id, provider name, sensor id. Never a credential. */
  source: string;
  evidence?: VerificationEvidence[];
}

export const PROVENANCE_DESCRIPTIONS: Record<ProvenanceLabel, { short: string; long: string }> = {
  illustrative: {
    short: "Illustrative",
    long: "Generated for visualisation only. Does not represent real-world conditions.",
  },
  "user-entered": {
    short: "User-entered",
    long: "Submitted by a user of this application and not independently verified.",
  },
  "provider-observation": {
    short: "Provider observation",
    long: "Delivered by an external data provider. Accuracy depends on that provider.",
  },
  "sensor-reported": {
    short: "Sensor-reported",
    long: "Reported by a registered sensor. Readings have not been independently checked.",
  },
  "independently-verified": {
    short: "Independently verified",
    long: "Checked by a reviewer against attached evidence. See the evidence records for scope.",
  },
};

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/**
 * Validates a provenance record. Throws when `independently-verified` is
 * claimed without evidence, or when evidence is attached to a label that
 * cannot carry it.
 */
export function assertValidProvenance(p: Provenance): Provenance {
  if (!PROVENANCE_LABELS.includes(p.label)) {
    throw new ProvenanceError(`unknown provenance label: ${String(p.label)}`);
  }
  if (Number.isNaN(Date.parse(p.sourceTimestamp))) {
    throw new ProvenanceError("sourceTimestamp must be an ISO-8601 timestamp");
  }
  const evidence = p.evidence ?? [];
  if (p.label === "independently-verified") {
    if (evidence.length === 0) {
      throw new ProvenanceError("independently-verified requires at least one evidence record");
    }
    for (const e of evidence) {
      if (!e.reviewerUserId || !e.mediaObjectId || Number.isNaN(Date.parse(e.reviewedAt))) {
        throw new ProvenanceError("evidence must name a reviewer, a media object and a review time");
      }
    }
  }
  return p;
}

/**
 * Computes the label a boundary should carry. A boundary starts `user-entered`
 * and only becomes `independently-verified` through an explicit verification
 * action with evidence. Removing evidence downgrades it again.
 */
export function boundaryProvenanceLabel(evidence: readonly VerificationEvidence[] | undefined): ProvenanceLabel {
  return evidence && evidence.length > 0 ? "independently-verified" : "user-entered";
}
