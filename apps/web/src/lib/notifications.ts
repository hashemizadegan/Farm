"use client";
import { useI18n } from "@/i18n/provider";
import type { Schemas } from "./api";

type N = Schemas["Notification"];

/** Text and link for a notification, in the reader's language. */
export function useNotificationText() {
  const { m, fmt } = useI18n();
  const t = m.notifications;
  return (n: N): { text: string; href: string } => {
    const d = n.data as Record<string, string>;
    switch (n.kind) {
      case "task_assigned":
        return { text: t.taskAssigned(d.title ?? "", d.farmName ?? "", d.dueDate ? fmt.day(d.dueDate) : ""), href: "/tasks" };
      case "alert_raised":
        return { text: t.alertRaised(m.alerts.severity[d.severity ?? ""] ?? d.severity ?? "", d.farmName ?? "", d.message ?? ""), href: `/farms/${d.farmId}/alerts` };
      case "low_stock":
        return { text: t.lowStock(d.itemName ?? "", fmt.number(Number(d.onHand), { maximumFractionDigits: 3 }), d.unit ?? ""), href: "/inventory" };
      case "maintenance_due":
        return { text: t.maintenanceDue(d.planTitle ?? "", d.equipmentName ?? ""), href: `/equipment/${d.equipmentId}` };
    }
  };
}
