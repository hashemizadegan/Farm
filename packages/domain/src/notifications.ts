/**
 * Notifications are stored as a kind plus data and rendered by the reader's
 * app in their language. Who receives what follows the role permissions.
 */
import { ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "./roles";

export const NOTIFICATION_KINDS = ["task_assigned", "alert_raised", "low_stock", "maintenance_due", "weekly_report"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationData {
  task_assigned: { taskId: string; farmId: string; farmName: string; title: string; dueDate: string };
  alert_raised: { alertId?: string; farmId: string; farmName: string; severity: string; message: string };
  low_stock: { itemId: string; itemName: string; onHand: string; unit: string };
  maintenance_due: { equipmentId: string; equipmentName: string; planTitle: string };
  weekly_report: { from: string; to: string; tasksDone: number; dueStillOpen: number; applications: number; harvestBatches: number; alerts: number };
}

/** Roles whose members should hear about events that need this permission to act on. */
export function rolesWith(permission: Permission): Role[] {
  return ROLES.filter((r) => ROLE_PERMISSIONS[r].has(permission));
}
