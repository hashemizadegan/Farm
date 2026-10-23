/**
 * Registered integrations (migration 0031): external sensor and observation feeds that post signed events to
 * `POST /v1/integrations/{integrationId}/events`. The contract is provider-neutral (`metafarm-integration-event/1`);
 * a provider's own payload format is mapped to it outside the platform, never guessed at here.
 *
 * Trust: the workspace of an event is the integration's own (resolved from the integration id in the path). Any
 * workspace identity in a payload is refused, wherever it appears. Farms and sensors named by a payload are looked up
 * inside the integration's workspace only, so an event can never reach another workspace. Accepted events are
 * normalized into the existing observation pipeline (raw observations + the observation-normalization queue), labelled
 * `provider-observation`; there is no second telemetry pipeline.
 */
import { z } from "zod";
import { createObservationSchema } from "./schemas";
import { ingestSchema } from "./sensors";

export const INTEGRATION_EVENT_SCHEME = "metafarm-integration-event/1";
export const INTEGRATION_KINDS = ["sensor_feed", "observation_feed"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Event types an integration may be allowed to post, and the integration kind each belongs to. */
export const INTEGRATION_EVENT_TYPES = {
  "sensor.readings": { kind: "sensor_feed" },
  "observation.reported": { kind: "observation_feed" },
} as const satisfies Record<string, { kind: IntegrationKind }>;
export type IntegrationEventType = keyof typeof INTEGRATION_EVENT_TYPES;
const eventTypeNames = Object.keys(INTEGRATION_EVENT_TYPES) as [IntegrationEventType, ...IntegrationEventType[]];

const uuid = z.string().uuid();
const providerEventId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, "1-200 characters: letters, digits and . _ : -");

export const registerIntegrationSchema = z
  .object({
    kind: z.enum(INTEGRATION_KINDS),
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits and hyphens"),
    name: z.string().trim().min(1).max(120),
    allowedEventTypes: z.array(z.enum(eventTypeNames)).min(1).max(16),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const t of v.allowedEventTypes) {
      if (INTEGRATION_EVENT_TYPES[t].kind !== v.kind) ctx.addIssue({ code: "custom", path: ["allowedEventTypes"], message: `${t} is not a ${v.kind} event` });
    }
  });
export type RegisterIntegrationInput = z.infer<typeof registerIntegrationSchema>;

const sensorReadings = z
  .object({
    scheme: z.literal(INTEGRATION_EVENT_SCHEME),
    id: providerEventId,
    type: z.literal("sensor.readings"),
    sensorId: uuid,
    readings: ingestSchema.shape.readings,
  })
  .strict();

const observationReported = z
  .object({
    scheme: z.literal(INTEGRATION_EVENT_SCHEME),
    id: providerEventId,
    type: z.literal("observation.reported"),
    farmId: uuid,
    observations: z.array(createObservationSchema.strict()).min(1).max(200),
  })
  .strict();

export const integrationEventSchema = z.discriminatedUnion("type", [sensorReadings, observationReported]);
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;

export class IntegrationEventRefusal extends Error {
  constructor(
    readonly code: "malformed" | "workspace_in_payload" | "event_type_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationEventRefusal";
  }
}

/** Keys that would name a workspace; refused anywhere in a payload (case-insensitive, any depth). */
const WORKSPACE_KEYS = new Set(["tenantid", "tenant_id", "tenant", "workspaceid", "workspace_id", "workspace"]);

export function findWorkspaceKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const k = findWorkspaceKey(v, depth + 1);
      if (k) return k;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (WORKSPACE_KEYS.has(k.toLowerCase())) return k;
    const inner = findWorkspaceKey(v, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/**
 * Validates an integration event for an integration allowed to post `allowed` types. Order matters: a workspace
 * identity in the payload is refused before anything else is read from it.
 */
export function parseIntegrationEvent(body: unknown, allowed: readonly string[]): IntegrationEvent {
  const key = findWorkspaceKey(body);
  if (key) throw new IntegrationEventRefusal("workspace_in_payload", `the payload names a workspace (${key}); the workspace is the integration's own`);
  const r = integrationEventSchema.safeParse(body);
  if (!r.success) throw new IntegrationEventRefusal("malformed", r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 500));
  if (!allowed.includes(r.data.type)) throw new IntegrationEventRefusal("event_type_not_allowed", `${r.data.type} is not allowed for this integration`);
  return r.data;
}
