DELETE FROM notifications WHERE kind = 'weekly_report';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'alert_raised', 'low_stock', 'maintenance_due'));
