/**
 * Internal event envelope `metafarm-event/1`, prepared for a future realtime channel (WebSocket or MQTT to clients).
 * Nothing publishes or serves these yet: there is no client push endpoint, and the server switch
 * REALTIME_EVENTS_ENABLED is off by default and refused when deployed. The envelope, its per-type payload schemas
 * and the authorization rule are fixed first, so a transport can be added against tested contracts.
 *
 * Authorization (`authorizeEvent`): a viewer receives an event only for a workspace they belong to, only with the
 * permission the event type requires, and, for a farm-scoped event, only when the farm belongs to that workspace
 * (the caller resolves that from the database, never from the event). Anything unknown is denied.
 */
import { z } from "zod";
import { can, type Permission, type Role } from "./roles";

export const EVENT_ENVELOPE_SCHEME = "metafarm-event/1";

const uuid = z.string().uuid();
const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/).refine((v) => !Number.isNaN(Date.parse(v)), "not a valid time");

/** Event types, their payload schema, schema version and the permission a viewer needs. Unknown types are refused. */
export const EVENT_TYPES = {
  "yield.cycle.updated": {
    schemaVersion: 1,
    permission: "yield:read" as Permission,
    farmScoped: false,
    payload: z.object({ cycleId: uuid, status: z.string().regex(/^[a-z_]{1,40}$/), simulation: z.boolean() }).strict(),
  },
  "twin.snapshot.recorded": {
    schemaVersion: 1,
    permission: "farm:read" as Permission,
    farmScoped: true,
    payload: z.object({ commitmentId: uuid, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  },
  "alert.raised": {
    schemaVersion: 1,
    permission: "alert:read" as Permission,
    farmScoped: true,
    payload: z.object({ alertId: uuid, severity: z.enum(["info", "warning", "critical"]) }).strict(),
  },
} as const;
export type EventType = keyof typeof EVENT_TYPES;

const envelopeShape = z
  .object({
    scheme: z.literal(EVENT_ENVELOPE_SCHEME),
    type: z.string(),
    schemaVersion: z.number().int().min(1).max(1000),
    id: uuid,
    scope: z.object({ tenantId: uuid, farmId: uuid.nullable() }).strict(),
    occurredAt: rfc3339,
    correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
    payload: z.record(z.unknown()),
  })
  .strict();

export interface EventEnvelope<T extends EventType = EventType> {
  scheme: typeof EVENT_ENVELOPE_SCHEME;
  type: T;
  schemaVersion: number;
  id: string;
  scope: { tenantId: string; farmId: string | null };
  occurredAt: string;
  correlationId: string | null;
  payload: z.infer<(typeof EVENT_TYPES)[T]["payload"]>;
}

export class EventEnvelopeError extends Error {
  constructor(
    readonly code: "malformed" | "unknown_type" | "unsupported_version" | "scope_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "EventEnvelopeError";
  }
}

/** Validates an envelope and its payload against the type's schema. Exact keys; nothing is defaulted. */
export function parseEventEnvelope(input: unknown): EventEnvelope {
  const r = envelopeShape.safeParse(input);
  if (!r.success) throw new EventEnvelopeError("malformed", r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  const e = r.data;
  const spec = (EVENT_TYPES as Record<string, (typeof EVENT_TYPES)[EventType]>)[e.type];
  if (!spec) throw new EventEnvelopeError("unknown_type", `unknown event type ${e.type}`);
  if (e.schemaVersion !== spec.schemaVersion) throw new EventEnvelopeError("unsupported_version", `${e.type} is at schema version ${spec.schemaVersion}, not ${e.schemaVersion}`);
  if (spec.farmScoped !== (e.scope.farmId !== null)) throw new EventEnvelopeError("scope_mismatch", `${e.type} is ${spec.farmScoped ? "farm" : "workspace"}-scoped`);
  const p = spec.payload.safeParse(e.payload);
  if (!p.success) throw new EventEnvelopeError("malformed", `payload: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return { ...e, type: e.type as EventType, payload: p.data } as EventEnvelope;
}

export interface EventViewer {
  /** The viewer's role per workspace (from memberships). */
  roles: Readonly<Record<string, Role>>;
}

export type EventDecision = { allow: true } | { allow: false; reason: "not_a_member" | "missing_permission" | "farm_outside_workspace" };

/**
 * Whether a viewer may receive an event. `farmInWorkspace` is the database's answer to "does scope.farmId belong to
 * scope.tenantId" (ignored for workspace-scoped events); the event's own claim is never trusted for it.
 */
export function authorizeEvent(e: EventEnvelope, viewer: EventViewer, farmInWorkspace: boolean): EventDecision {
  const role = viewer.roles[e.scope.tenantId];
  if (!role) return { allow: false, reason: "not_a_member" };
  if (!can(role, EVENT_TYPES[e.type].permission)) return { allow: false, reason: "missing_permission" };
  if (e.scope.farmId !== null && !farmInWorkspace) return { allow: false, reason: "farm_outside_workspace" };
  return { allow: true };
}
