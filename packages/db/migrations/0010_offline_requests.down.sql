ALTER TABLE farm_tasks DROP COLUMN IF EXISTS completion_request_id;
DROP INDEX IF EXISTS harvest_batches_client_request_idx;
ALTER TABLE harvest_batches DROP COLUMN IF EXISTS client_request_id;
DROP INDEX IF EXISTS raw_observations_client_request_idx;
ALTER TABLE raw_observations DROP COLUMN IF EXISTS client_request_id;
