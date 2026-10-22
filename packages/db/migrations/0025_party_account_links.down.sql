-- Reverses 0025 (Y12). Drops only what 0025 created.
DROP TABLE IF EXISTS party_account_link_events;
DROP TABLE IF EXISTS party_account_links;
DROP FUNCTION IF EXISTS party_account_links_guard();
DROP FUNCTION IF EXISTS party_account_links_proposed();
