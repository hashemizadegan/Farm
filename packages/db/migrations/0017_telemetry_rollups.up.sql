-- Hourly telemetry rollups for dashboards and alert rules, readable by the application only
-- through a tenant-filtered view, and an operator switch for raw-data retention.
--
-- With TimescaleDB (iot_telemetry is a hypertable, 0011): a continuous aggregate refreshed every
-- 30 minutes. Without it (CI, local PostGIS): a plain view computing the same columns on read.
--
-- Deliberately NOT done here:
-- * Columnstore compression. TimescaleDB does not support row-level security on chunks in the
--   columnstore (docs: api/hypercore), so compressing iot_telemetry would drop tenant isolation for
--   older readings. Revisit only with per-tenant access enforced some other way.
-- * Real-time aggregation. The rollup is materialised only: a security-barrier view over a
--   continuous aggregate fails permission checks in real-time mode (timescale/timescaledb#2955),
--   so the newest hour appears after the next refresh.
-- * A default retention. Deleting readings is the operator's decision: telemetry_set_retention().

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- Nested: timescaledb_information exists only with the extension.
    IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema = current_schema() AND hypertable_name = 'iot_telemetry') THEN
      EXECUTE $sql$
        CREATE MATERIALIZED VIEW iot_telemetry_hourly WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, tenant_id, farm_id, sensor_id, metric, unit,
               count(*) AS samples, avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
          FROM iot_telemetry
         GROUP BY bucket, tenant_id, farm_id, sensor_id, metric, unit
        WITH NO DATA
      $sql$;
      PERFORM add_continuous_aggregate_policy('iot_telemetry_hourly',
        start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes');
      RETURN;
    END IF;
  END IF;
  -- Buckets in UTC like time_bucket(): date_trunc on timestamptz would follow the session's time
  -- zone, which splits hours differently under half-hour offsets (e.g. Asia/Tehran, Asia/Kolkata).
  EXECUTE $sql$
    CREATE VIEW iot_telemetry_hourly AS
    SELECT date_trunc('hour', time, 'UTC') AS bucket, tenant_id, farm_id, sensor_id, metric, unit,
           count(*) AS samples, avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
      FROM iot_telemetry
     GROUP BY 1, tenant_id, farm_id, sensor_id, metric, unit
  $sql$;
END $$;

-- The rollup itself is materialised by its owner, so row-level security on iot_telemetry does not
-- reach it: the application never reads it directly, only through this filter on its own tenant.
REVOKE ALL ON iot_telemetry_hourly FROM PUBLIC;
CREATE VIEW iot_telemetry_hourly_tenant WITH (security_barrier = true) AS
  SELECT bucket, tenant_id, farm_id, sensor_id, metric, unit, samples, avg_value, min_value, max_value
    FROM iot_telemetry_hourly
   WHERE tenant_id = app_current_tenant();
GRANT SELECT ON iot_telemetry_hourly_tenant TO metafarm_app;

-- Operator switch: keep raw readings for `keep` (at least 7 days, so the rollup has refreshed
-- them first), or NULL to keep them forever. Hourly rollups are not affected.
CREATE FUNCTION telemetry_set_retention(keep interval) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF keep IS NOT NULL AND keep < INTERVAL '7 days' THEN
    RAISE EXCEPTION 'keep raw telemetry for at least 7 days (asked: %)', keep USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE EXCEPTION 'retention policies need TimescaleDB' USING ERRCODE = 'feature_not_supported';
  END IF;
  PERFORM remove_retention_policy('iot_telemetry', if_exists => true);
  IF keep IS NOT NULL THEN
    PERFORM add_retention_policy('iot_telemetry', drop_after => keep);
  END IF;
END $$;
REVOKE ALL ON FUNCTION telemetry_set_retention(interval) FROM PUBLIC;
