"use client";
import { PageHeader } from "@metafarm/ui";
import { PeriodReport } from "@/components/PeriodReport";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";

export default function ReportsPage() {
  const t = useI18n().m.reports;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <PeriodReport tenantId={tenantId} />}</RequireTenant>
    </>
  );
}
