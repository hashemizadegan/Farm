-- Stored responses for retried writes; dropping them only means a resend after this point may record twice.
DROP TABLE idempotency_records;
