-- Reverses 0028. Drops only what 0028 created.
DROP TRIGGER IF EXISTS yield_cycles_require_zcarry ON yield_cycles;
DROP FUNCTION IF EXISTS yield_cycles_require_carry();
DROP TABLE IF EXISTS yield_carry_ledgers;
DROP FUNCTION IF EXISTS yield_carry_ledgers_guard();
DROP FUNCTION IF EXISTS yield_carry_source(uuid);
