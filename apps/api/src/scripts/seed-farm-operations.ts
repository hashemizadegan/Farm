/**
 * Preview and local seed for the farm operations journey (farm → current conditions → observation → its source →
 * the integration feeding the farm). **Simulation data**, every name labelled "(simulation)", in the demo workspace
 * (run `pnpm db:seed` first). Driven through the real routes in-process and the worker's own normalization handler, so
 * every rule applies (authorization, signed ingestion, provenance, unit normalization, sensor freshness).
 *
 *   "North orchard (simulation)":
 *   - Soil probe A: reporting (readings through a registered integration, or its device token without one);
 *   - Soil probe B: silent (its last reading is three days old, past its 60-minute allowance);
 *   - Weather mast: waiting for a first reading;
 *   - Rain gauge: disabled;
 *   - one observation entered by a person.
 *   Freshness is computed against the current time: probe A stays "reporting" for up to 7 days after seeding.
 *
 * The integration's signing secret is derived in memory to sign the sample events and never printed or stored; an
 * operator who wants to send events issues a new one with "Rotate secret" on the Integrations page. Without
 * INTEGRATION_SECRET_KEY the integration part is skipped (with a message) and probe A reports through its device token.
 *
 * Refused unless APP_ENV is development or test. Idempotent: a second run reports the existing farm and changes nothing.
 * Usage: pnpm seed:farm-ops   (or step 3 of the preview seed runner)
 */
import { apiEnvSchema } from "@metafarm/config";
import { createPool, withSystem } from "@metafarm/db";
import { QUEUES, type ObservationNormalizationJob } from "@metafarm/domain";
import { signWebhook } from "@metafarm/domain/server";
import { createLogger } from "@metafarm/observability";
import { createMemoryStorage } from "@metafarm/storage";
import { observationNormalizationHandler } from "../../../worker/src/handlers/observations";
import { buildApp } from "../app";
import { createDevProvider, mintDevToken } from "../auth/dev";
import { createMemoryProducer } from "../queue/producer";

export const FARM_OPS_FARM = "North orchard (simulation)";
export const FARM_OPS_SENSORS = {
  reporting: "Soil probe A (simulation)",
  silent: "Soil probe B (simulation)",
  waiting: "Weather mast (simulation)",
  disabled: "Rain gauge (simulation)",
} as const;
export const FARM_OPS_INTEGRATION = "Simulated field feed";

const log = (m: string) => console.log(`[seed:farm-ops] ${m}`);
const fail = (m: string): never => {
  console.error(`[seed:farm-ops] refused: ${m}`);
  process.exit(1);
};

if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") fail("APP_ENV must be development or test (simulation data for a local or isolated preview database)");
const secret = process.env.DEV_AUTH_SECRET ?? fail("DEV_AUTH_SECRET must be set (the seed signs in as dev-user)");
const env = apiEnvSchema.parse(process.env);
const pool = createPool({ connectionString: env.DATABASE_URL, max: 4 });

async function main() {
  const tenantId = (await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'demo'`)).rows[0]?.id;
  if (!tenantId) throw new Error("no demo workspace: run `pnpm db:seed` (or the preview seed runner) first");
  const existing = (await pool.query<{ id: string }>(`SELECT id FROM farms WHERE tenant_id = $1 AND name = $2`, [tenantId, FARM_OPS_FARM])).rows[0];
  if (existing) {
    log(`already seeded: ${FARM_OPS_FARM} (${existing.id})`);
    return;
  }

  const jobs = createMemoryProducer();
  const app = await buildApp({
    deps: { env, logger: createLogger({ service: "seed-farm-ops", level: "warn" }), pool, jobs, storage: createMemoryStorage(), auth: createDevProvider(secret), now: () => new Date() },
    docs: false,
  });
  const owner = `Bearer ${await mintDevToken(secret, "dev-user", "dev-user")}`;
  const call = async <T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = { authorization: owner }): Promise<T> => {
    const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (r.statusCode >= 300) throw new Error(`${method} ${url.replace(/[0-9a-f-]{36}/g, "…")} → ${r.statusCode} ${r.json().error ?? ""}`);
    return r.json() as T;
  };
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  try {
    const t = `/v1/tenants/${tenantId}`;
    const farm = await call<{ id: string }>("POST", `${t}/farms`, { name: FARM_OPS_FARM, description: "Simulation data for the preview walkthrough; not a real farm." });
    const f = `${t}/farms/${farm.id}`;
    const sensor = (name: string, kind: string, silentAfterMinutes: number) =>
      call<{ sensor: { id: string }; token: string }>("POST", `${f}/sensors`, { name, kind, parcelLabel: "Block 1 (simulation)", silentAfterMinutes });
    const a = await sensor(FARM_OPS_SENSORS.reporting, "soil-moisture", 10_080);
    const b = await sensor(FARM_OPS_SENSORS.silent, "soil-moisture", 60);
    await sensor(FARM_OPS_SENSORS.waiting, "weather-station", 180);
    const d = await sensor(FARM_OPS_SENSORS.disabled, "rain-gauge", 180);
    await call("PATCH", `${f}/sensors/${d.sensor.id}`, { status: "disabled" });

    // Probe A: through a registered integration (signed events), or its device token without integrations.
    const readingsA = [
      { at: 75, moisture: 22.8, temperature: 16.9 },
      { at: 15, moisture: 23.4, temperature: 18.2 },
    ];
    if (env.INTEGRATION_SECRET_KEY) {
      const reg = await call<{ integration: { id: string }; secret: string }>("POST", `${t}/integrations`, {
        kind: "sensor_feed",
        provider: "metafarm-simulation",
        name: FARM_OPS_INTEGRATION,
        allowedEventTypes: ["sensor.readings"],
      });
      for (const [i, r] of readingsA.entries()) {
        const raw = JSON.stringify({
          scheme: "metafarm-integration-event/1",
          id: `simulation-${i + 1}`,
          type: "sensor.readings",
          sensorId: a.sensor.id,
          readings: [
            { metric: "soil_moisture", value: r.moisture, unit: "percent_vwc", observedAt: ago(r.at) },
            { metric: "air_temperature", value: r.temperature, unit: "celsius", observedAt: ago(r.at) },
          ],
        });
        // The secret stays in memory: it signs these two sample events and is dropped.
        await call("POST", `/v1/integrations/${reg.integration.id}/events`, raw, { "content-type": "application/json", "x-webhook-signature": signWebhook(reg.secret, raw, Math.floor(Date.now() / 1000)) });
      }
      log(`integration "${FARM_OPS_INTEGRATION}" registered; 2 signed events accepted (its secret is not kept: rotate it on the Integrations page to send more)`);
    } else {
      for (const r of readingsA) {
        await call("POST", "/v1/ingest/readings", { readings: [{ metric: "soil_moisture", value: r.moisture, unit: "percent_vwc", observedAt: ago(r.at) }] }, { authorization: `Sensor ${a.token}` });
      }
      log("INTEGRATION_SECRET_KEY is not set: no integration was registered; probe A reported through its device token. Set the key on api and seed-runner and re-seed a fresh database to include it.");
    }

    // Probe B: one reading three days ago, then silent. Its last-seen time is set to that reading (simulation).
    await call("POST", "/v1/ingest/readings", { readings: [{ metric: "soil_moisture", value: 31.0, unit: "percent_vwc", observedAt: ago(3 * 24 * 60) }] }, { authorization: `Sensor ${b.token}` });
    await withSystem(pool, (tx) => tx.query(`UPDATE sensors SET last_seen_at = now() - interval '3 days' WHERE id = $1`, [b.sensor.id]));

    // A person's note.
    await call("POST", `${f}/observations`, { metric: "note", value: "Drip line in block 1 checked (simulation)", unit: "text", observedAt: ago(45) });

    // The worker's own normalization handler, in-process (the preview may run without a worker).
    const handler = observationNormalizationHandler(pool, undefined, { realtime: env.REALTIME_EVENTS_ENABLED });
    const ctx = { log: createLogger({ service: "seed-farm-ops", level: "warn" }), attempt: 1, jobId: "seed-farm-ops" };
    let normalized = 0;
    for (const j of jobs.jobs.filter((x) => x.queue === QUEUES.observations)) {
      await handler(j.payload as ObservationNormalizationJob, ctx);
      normalized++;
    }

    const states = (await call<{ items: { name: string; state: string }[] }>("GET", `${f}/sensors`)).items.map((s) => `${s.name}: ${s.state}`);
    log(`${FARM_OPS_FARM} (${farm.id}): ${normalized} observations normalized; sensors — ${states.join("; ")}`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("[seed:farm-ops] failed:", e instanceof Error ? e.message : e);
    await pool.end();
    process.exit(1);
  });
