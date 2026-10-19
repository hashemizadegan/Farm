DROP VIEW IF EXISTS iot_telemetry_hourly_tenant;
DROP FUNCTION IF EXISTS telemetry_set_retention(interval);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM remove_retention_policy('iot_telemetry', if_exists => true);
    IF EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_schema = current_schema() AND view_name = 'iot_telemetry_hourly') THEN
      EXECUTE 'DROP MATERIALIZED VIEW iot_telemetry_hourly';
      RETURN;
    END IF;
  END IF;
  EXECUTE 'DROP VIEW IF EXISTS iot_telemetry_hourly';
END $$;
