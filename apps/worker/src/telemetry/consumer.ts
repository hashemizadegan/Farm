/** MQTT-over-TLS consumer: subscribes to sensor telemetry and stores it in iot_telemetry. */
import { connect, type IClientOptions } from "mqtt";
import { insertTelemetry, telemetrySensor, withSystem, withTenant, type Pool, type TelemetryRow } from "@metafarm/db";
import { telemetryTopicFilter } from "@metafarm/domain";
import type { Logger } from "@metafarm/observability";
import { TelemetryBatcher } from "./batcher";
import { cachedLookup, prepareTelemetry } from "./pipeline";

export interface TelemetryConsumerConfig {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  ca?: string;
  cert?: string;
  key?: string;
  prefix: string;
  batchSize: number;
  flushMs: number;
}

type Tagged = TelemetryRow & { tenantId: string };

export function startTelemetryConsumer(cfg: TelemetryConsumerConfig, pool: Pool, logger: Logger) {
  const lookup = cachedLookup((id) => withSystem(pool, (tx) => telemetrySensor(tx, id)));
  const batcher = new TelemetryBatcher<Tagged>({
    maxRows: cfg.batchSize,
    maxWaitMs: cfg.flushMs,
    write: async (rows) => {
      const byTenant = new Map<string, TelemetryRow[]>();
      for (const { tenantId, ...row } of rows) byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), row]);
      let stored = 0;
      for (const [tenantId, list] of byTenant) stored += await withTenant(pool, tenantId, (tx) => insertTelemetry(tx, list));
      logger.debug({ received: rows.length, stored }, "telemetry stored");
    },
    onError: (err, rows) => {
      // Not acknowledged: reconnect so the broker delivers those messages again (persistent session).
      logger.error({ err, rows }, "telemetry write failed; reconnecting for redelivery");
      client.end(true, {}, () => client.reconnect());
    },
  });

  const options: IClientOptions = {
    clientId: cfg.clientId,
    username: cfg.username,
    password: cfg.password,
    ca: cfg.ca,
    cert: cfg.cert,
    key: cfg.key,
    rejectUnauthorized: true,
    protocolVersion: 5,
    // Keep the session (and unacknowledged QoS 1 messages) across reconnects.
    clean: false,
    properties: { sessionExpiryInterval: 3_600 },
    reconnectPeriod: 5_000,
    customHandleAcks: (topic, message, _packet, done) => {
      void prepareTelemetry(topic, message, { prefix: cfg.prefix, lookup })
        .then((p) => {
          if (!p.ok) {
            // A message that can never be stored is acknowledged and dropped, not redelivered forever.
            logger.warn({ topic, reason: p.reason }, "telemetry message refused");
            done(0);
            return;
          }
          if (p.rejected) logger.warn({ topic, rejected: p.rejected }, "telemetry readings refused");
          if (p.rows.length === 0) return done(0);
          batcher.add(
            p.rows.map((r) => ({ ...r, tenantId: p.tenantId })),
            () => done(0),
          );
        })
        .catch((err: unknown) => logger.error({ err, topic }, "telemetry message failed; left for redelivery"));
    },
  };

  // Referenced by the batcher's error handler, which only runs after messages have arrived.
  const client = connect(cfg.url, options);
  client.on("connect", () => {
    client.subscribe(telemetryTopicFilter(cfg.prefix), { qos: 1 }, (err) => {
      if (err) logger.error({ err }, "telemetry subscribe failed");
      else logger.info({ topic: telemetryTopicFilter(cfg.prefix) }, "telemetry subscribed");
    });
  });
  client.on("error", (err) => logger.error({ err: err.message }, "MQTT error"));

  return {
    async close() {
      await batcher.flush();
      await client.endAsync();
    },
  };
}
