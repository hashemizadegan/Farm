-- Offline field use: phones queue writes and resend them when back online. A resend after a
-- dropped response must not record twice, so these writes carry the client's request id.
ALTER TABLE raw_observations ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX raw_observations_client_request_idx ON raw_observations (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE harvest_batches ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX harvest_batches_client_request_idx ON harvest_batches (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE farm_tasks ADD COLUMN completion_request_id uuid;
