"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Notice, SelectField, useAnnounce } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";

/** Workspace setting: the weekly summary for owners, admins and managers, and the day weeks start. */
export function WeeklyReportSettings({ tenantId }: { tenantId: string }) {
  const { m } = useI18n();
  const t = m.wsSettings.weekly;
  const can = useCan();
  const announce = useAnnounce();
  const settings = useQuery(`ws-settings:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/settings", { params: { path: { tenantId } } })));
  const current = settings.data?.weeklyReport;
  const [enabled, setEnabled] = useState(true);
  const [weekStartsOn, setWeekStartsOn] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!current) return;
    setEnabled(current.enabled);
    setWeekStartsOn(current.weekStartsOn);
  }, [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/settings", { params: { path: { tenantId } }, body: { weeklyReport: { enabled, weekStartsOn } } }));
      announce(t.saved);
      settings.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="weekly-heading">
      <h2 id="weekly-heading">{t.heading}</h2>
      <p className="mf-hint">{t.intro}</p>
      {settings.error && <Notice tone="error">{settings.error.message}</Notice>}
      {current &&
        (can("member:manage") ? (
          <form onSubmit={save} noValidate>
            <div className="mf-field checkbox-field">
              <input id="weekly-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <label htmlFor="weekly-enabled">{t.enabled}</label>
            </div>
            <SelectField label={t.weekStartsOn} hint={t.weekStartsOnHint} value={String(weekStartsOn)} onChange={(e) => setWeekStartsOn(Number(e.target.value))}>
              {[6, 0, 1].map((d) => (
                <option key={d} value={d}>
                  {t.days[d as 0 | 1 | 6]}
                </option>
              ))}
            </SelectField>
            {error && (
              <p className="mf-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              {m.common.save}
            </Button>
          </form>
        ) : (
          <p>{current.enabled ? t.onReadonly(t.days[current.weekStartsOn as 0 | 1 | 6] ?? String(current.weekStartsOn)) : t.offReadonly}</p>
        ))}
    </section>
  );
}
