-- Realtime outbox: durable, ordered, workspace-scoped events (envelope metafarm-event/1, packages/domain events.ts)
-- for the authenticated realtime channel (apps/api routes/realtime.ts). Notifications only: no financial or ownership
-- state is ever carried or changed by a row here. Nothing earlier is altered.
--
-- Ordering: `seq` is the replay cursor. Writers take a per-workspace transaction lock before inserting
-- (appendRealtimeEvent), so within one workspace sequence numbers become visible in commit order and a reader that
-- has seen `seq = n` can never later find an uncommitted `seq < n` appear. Readers always filter by workspace.
-- Retention: rows are immutable; `expires_at` (default 7 days) tells the system pruning job what it may delete. The
-- application role can read and append, never update or delete.

CREATE TABLE realtime_events (
  seq             bigserial PRIMARY KEY,
  id              uuid NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  farm_id         uuid,
  type            text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$' AND length(type) <= 64),
  schema_version  integer NOT NULL CHECK (schema_version BETWEEN 1 AND 1000),
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  occurred_at     timestamptz NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CONSTRAINT realtime_events_retention CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);
CREATE INDEX realtime_events_tenant_seq_idx ON realtime_events (tenant_id, seq);
CREATE INDEX realtime_events_expires_idx ON realtime_events (expires_at);
CREATE TRIGGER realtime_events_append_only BEFORE UPDATE ON realtime_events FOR EACH ROW EXECUTE FUNCTION append_only();

ALTER TABLE realtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON realtime_events TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON realtime_events TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON realtime_events TO metafarm_app;
GRANT USAGE ON SEQUENCE realtime_events_seq_seq TO metafarm_app;
