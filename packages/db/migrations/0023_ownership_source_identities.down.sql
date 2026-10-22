-- Removes the cluster identity binding (Y0). Events and cursors keep their rows; the identity link is lost.
DROP INDEX chain_ownership_events_source_identity_idx;
ALTER TABLE chain_ownership_cursors DROP CONSTRAINT chain_ownership_cursors_identity_check;
ALTER TABLE chain_ownership_events DROP CONSTRAINT chain_ownership_events_identity_check;
ALTER TABLE chain_ownership_cursors DROP CONSTRAINT chain_ownership_cursors_identity_fkey;
ALTER TABLE chain_ownership_events DROP CONSTRAINT chain_ownership_events_identity_fkey;
ALTER TABLE chain_ownership_cursors DROP COLUMN source_identity_id;
ALTER TABLE chain_ownership_events DROP COLUMN source_identity_id;
DROP TABLE ownership_source_identities;
