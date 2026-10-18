/** MQTT telemetry path against a real database (without a broker): checks, batching, storage, dedupe. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createPool, createTenantWithOwner, insertTelemetry, migrateUp, telemetrySensor, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { prepareTelemetry } from "./telemetry/pipeline";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("telemetry storage", () => {
  let pool: Pool;
  let tenantId: string;
  let sensorId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    const user = (await upsertUserBySubject(pool, { issuer: "test", subject: `tel-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tel-${sfx}`, name: "Tel", ownerUserId: user }));
    const farm = await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: user }));
    sensorId = (
      await withTenant(pool, tenantId, (tx) => tx.query<{ id: string }>(`INSERT INTO sensors (tenant_id, farm_id, name, kind) VALUES ($1, $2, 'Probe', 'soil-moisture') RETURNING id`, [tx.tenantId, farm.id]))
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores readings once, however often a message is delivered, and marks the sensor heard from", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        messageId: "probe:1",
        readings: [
          { metric: "soil_moisture", value: 0.3, unit: "fraction_vwc", observedAt: "2026-10-18T06:00:00Z" },
          { metric: "soil_temperature", value: 18.5, unit: "celsius", observedAt: "2026-10-18T06:00:00Z" },
        ],
      }),
    );
    const lookup = (id: string) => withSystem(pool, (tx) => telemetrySensor(tx, id));
    const p = await prepareTelemetry(`metafarm/${tenantId}/sensors/${sensorId}/telemetry`, payload, { prefix: "metafarm", lookup });
    if (!p.ok) throw new Error(p.reason);
    expect(await withTenant(pool, p.tenantId, (tx) => insertTelemetry(tx, p.rows))).toBe(2);
    expect(await withTenant(pool, p.tenantId, (tx) => insertTelemetry(tx, p.rows))).toBe(0);
    const stored = await withTenant(pool, tenantId, (tx) =>
      tx.query(`SELECT metric, value, unit, message_id, payload_sha256, quality_flags FROM iot_telemetry WHERE sensor_id = $1 ORDER BY metric`, [sensorId]),
    );
    expect(stored.rows).toEqual([
      { metric: "soil_moisture", value: 30, unit: "percent_vwc", message_id: "probe:1", payload_sha256: p.rows[0]!.payloadSha256, quality_flags: [] },
      { metric: "soil_temperature", value: 18.5, unit: "celsius", message_id: "probe:1", payload_sha256: p.rows[0]!.payloadSha256, quality_flags: [] },
    ]);
    const seen = await withTenant(pool, tenantId, (tx) => tx.query(`SELECT last_seen_at FROM sensors WHERE id = $1`, [sensorId]));
    expect(seen.rows[0].last_seen_at).not.toBeNull();
  });
});
