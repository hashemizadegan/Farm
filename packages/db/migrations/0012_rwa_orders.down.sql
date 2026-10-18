ALTER TABLE reconciliation_cases DROP CONSTRAINT IF EXISTS reconciliation_cases_tenant_id_reconciliation_id_fkey;
ALTER TABLE settlement_intents DROP CONSTRAINT IF EXISTS settlement_intents_tenant_id_reconciliation_id_fkey,
  DROP CONSTRAINT IF EXISTS settlement_intents_tenant_id_party_id_fkey, DROP COLUMN IF EXISTS party_id;
ALTER TABLE issuance_intents DROP CONSTRAINT IF EXISTS issuance_intents_tenant_id_reconciliation_id_fkey,
  DROP CONSTRAINT IF EXISTS issuance_intents_tenant_id_party_id_fkey, DROP COLUMN IF EXISTS party_id;
DROP TABLE IF EXISTS rwa_orders;
DROP TABLE IF EXISTS compliance_screenings;
DROP TABLE IF EXISTS party_wallets;
DROP TABLE IF EXISTS parties;
