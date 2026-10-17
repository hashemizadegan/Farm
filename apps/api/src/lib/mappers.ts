import type { AlertRow, BoundaryRow, FarmPlanRow, FarmRow, MediaRow, ObservationRow, ScenarioRow } from "@metafarm/db";

/** Row → API shape. Keeps database column names out of the public contract. */
export const toFarm = (f: FarmRow) => ({
  id: f.id,
  name: f.name,
  description: f.description,
  timezone: f.timezone,
  origin: f.origin,
  originProvenance: f.origin_provenance,
  currentBoundaryVersionId: f.current_boundary_version_id,
  outline: f.outline,
  boundaryAreaM2: f.boundary_area_m2 === null ? null : Math.round(f.boundary_area_m2),
  archivedAt: f.archived_at ? new Date(f.archived_at).toISOString() : null,
  createdAt: new Date(f.created_at).toISOString(),
});

export const toBoundary = (b: BoundaryRow, overlaps?: { farm_id: string; overlap_m2: number }[]) => ({
  id: b.id,
  farmId: b.farm_id,
  version: b.version,
  geojson: b.geojson,
  crs: b.crs,
  source: b.source,
  provenance: b.provenance_label,
  areaM2: Math.round(b.area_m2 * 100) / 100,
  vertexCount: b.vertex_count,
  validationStatus: b.validation_status,
  validationIssues: b.validation_issues,
  ...(overlaps ? { overlaps: overlaps.map((o) => ({ farmId: o.farm_id, overlapM2: Math.round(o.overlap_m2) })) } : {}),
  note: b.note,
  submittedAt: new Date(b.submitted_at).toISOString(),
  validatedAt: b.validated_at ? new Date(b.validated_at).toISOString() : null,
});

export const toPlan = (p: FarmPlanRow) => ({
  id: p.id,
  farmId: p.farm_id,
  name: p.name,
  season: p.season ?? undefined,
  parcels: p.parcels,
  provenance: p.provenance_label,
  createdAt: new Date(p.created_at).toISOString(),
});

export const toScenario = (s: ScenarioRow) => ({
  id: s.id,
  farmId: s.farm_id,
  kind: s.kind,
  input: s.input,
  result: s.result,
  createdAt: new Date(s.created_at).toISOString(),
});

export const toObservation = (o: ObservationRow) => ({
  id: o.id,
  farmId: o.farm_id,
  sensorId: o.sensor_id,
  metric: o.metric,
  value: o.value,
  text: o.text_value,
  unit: o.unit,
  observedAt: new Date(o.observed_at).toISOString(),
  provenance: o.provenance_label,
  qualityFlags: o.quality_flags,
});

export const toAlert = (a: AlertRow) => ({
  id: a.id,
  farmId: a.farm_id,
  ruleId: a.rule_id,
  severity: a.severity,
  message: a.message,
  status: a.status,
  evidenceObservationIds: a.evidence_observation_ids,
  acknowledgedAt: a.acknowledged_at ? new Date(a.acknowledged_at).toISOString() : null,
  createdAt: new Date(a.created_at).toISOString(),
});

export const toMedia = (m: MediaRow) => ({
  id: m.id,
  farmId: m.farm_id,
  filename: m.filename,
  contentType: m.content_type,
  byteSize: Number(m.byte_size),
  purpose: m.purpose,
  status: m.status,
  createdAt: new Date(m.created_at).toISOString(),
});
