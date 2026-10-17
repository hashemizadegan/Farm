"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useI18n } from "@/i18n/provider";

export default function FarmSettingsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const { m } = useI18n();
  return (
    <>
      <h1>{m.farmSettings.title}</h1>
      <RequireTenant>{(tenantId) => <Settings tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

/** Time zones the browser knows, for the picker; the API validates the value again. */
function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["UTC"];
}

function Settings({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const router = useRouter();
  const announce = useAnnounce();
  const can = useCan();
  const { m, fmt } = useI18n();
  const t = m.farmSettings;
  const farm = useQuery(`farm:${farmId}:settings`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId, farmId } } })),
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!farm.data) return;
    setName(farm.data.name);
    setDescription(farm.data.description ?? "");
    setTimezone(farm.data.timezone);
  }, [farm.data]);

  if (farm.loading && !farm.data) return <p role="status">{m.common.loading}</p>;
  if (farm.error) return <Notice tone="error" title={m.farm.couldNotLoad}>{farm.error.message}</Notice>;
  if (!can("farm:write")) return <Notice>{t.cannot}</Notice>;
  const f = farm.data!;
  const zones = timeZones();

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (!name.trim()) {
      setErrors([{ field: "farm-name", message: t.nameRequired }]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await unwrap(
        api.PATCH("/v1/tenants/{tenantId}/farms/{farmId}", {
          params: { path: { tenantId, farmId } },
          body: { name: name.trim(), description: description.trim() || null, timezone },
        }),
      );
      setSaved(true);
      announce(t.saved);
      farm.reload();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    const archiving = !f.archivedAt;
    if (archiving && !window.confirm(t.archiveConfirm(f.name))) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST(archiving ? "/v1/tenants/{tenantId}/farms/{farmId}/archive" : "/v1/tenants/{tenantId}/farms/{farmId}/restore", {
          params: { path: { tenantId, farmId } },
        }),
      );
      announce(archiving ? t.archivedAnnounce : t.restoredAnnounce);
      if (archiving) router.push("/farms");
      else farm.reload();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={save} noValidate className="card" aria-labelledby="details-heading" style={{ maxWidth: "44rem" }}>
        <h2 id="details-heading" style={{ marginTop: 0 }}>
          {t.details}
        </h2>
        <ErrorSummary errors={errors} />
        {saved && <Notice title={t.savedTitle}>{t.savedText}</Notice>}
        <TextField id="farm-name" label={t.name} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required error={errors.find((x) => x.field === "farm-name")?.message} />
        <div className="mf-field">
          <label htmlFor="farm-description">{t.description}</label>
          <p id="farm-description-hint" className="mf-hint">
            {t.descriptionHint}
          </p>
          <textarea id="farm-description" aria-describedby="farm-description-hint" rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="mf-field">
          <label htmlFor="farm-timezone">{t.timezone}</label>
          <p id="farm-timezone-hint" className="mf-hint">
            {t.timezoneHint}
          </p>
          <select id="farm-timezone" dir="ltr" aria-describedby="farm-timezone-hint" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="primary" busy={busy}>
          {t.save}
        </Button>
      </form>

      <section className="danger-zone" aria-labelledby="archive-heading" style={{ maxWidth: "44rem" }}>
        <h2 id="archive-heading">{f.archivedAt ? t.restoreHeading : t.archiveHeading}</h2>
        <p>
          {f.archivedAt ? t.archivedOn(fmt.date(f.archivedAt)) : t.archiveText}
        </p>
        <Button variant={f.archivedAt ? "secondary" : "danger"} onClick={toggleArchive} busy={busy}>
          {f.archivedAt ? t.restore : t.archive}
        </Button>
      </section>
    </>
  );
}
