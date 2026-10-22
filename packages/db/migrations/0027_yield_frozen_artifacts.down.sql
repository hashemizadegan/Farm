-- Reverses 0027. Drops only what 0027 created.
DROP TRIGGER IF EXISTS yield_cycles_require_frozen_artifact ON yield_cycles;
DROP FUNCTION IF EXISTS yield_cycles_require_frozen_artifact();
DROP TABLE IF EXISTS yield_claim_leaves;
DROP TABLE IF EXISTS yield_frozen_artifacts;
DROP FUNCTION IF EXISTS yield_frozen_artifacts_guard();
