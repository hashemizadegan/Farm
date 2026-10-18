"use client";
import { useParams } from "next/navigation";
import { PeriodReport } from "@/components/PeriodReport";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";

export default function FarmReportPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.reports;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.farmIntro}</p>
      <RequireTenant>{(tenantId) => <PeriodReport tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}
