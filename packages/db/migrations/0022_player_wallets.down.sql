-- Removes player-wallet links; users would have to link their wallets again. Party wallets are unaffected.
DROP TABLE IF EXISTS player_wallet_challenges;
DROP TABLE IF EXISTS player_wallets;
