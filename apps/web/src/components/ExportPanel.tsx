"use client";
import { useState } from "react";
import type { ExportDataset } from "@metafarm/domain";
import { Button, Notice, TextField, useAnnounce } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { API_URL } from "@/lib/api";
import { session } from "@/lib/auth";

/**
 * "Download as spreadsheet": CSV files for the given datasets, optionally limited to a date range
 * (and to one farm when `farmId` is set). Stock is a snapshot and ignores the range.
 */
export function ExportPanel({ tenantId, farmId, datasets }: { tenantId: string; farmId?: string; datasets: ExportDataset[] }) {
  const { m, locale } = useI18n();
  const t = m.exports;
  const announce = useAnnounce();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<ExportDataset>();
  const [error, setError] = useState<string>();
  const ranged = datasets.some((d) => d !== "stock");
  const badRange = Boolean(from && to && from > to);

  const download = async (dataset: ExportDataset) => {
    setBusy(dataset);
    setError(undefined);
    try {
      const q = new URLSearchParams({ lang: locale === "fa" ? "fa" : "en" });
      if (dataset !== "stock") {
        if (farmId) q.set("farmId", farmId);
        if (from) q.set("from", from);
        if (to) q.set("to", to);
      }
      const token = await session.getToken();
      const res = await fetch(`${API_URL}/v1/tenants/${tenantId}/exports/${dataset}?${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(body?.error === "export_too_large" ? t.tooLarge : t.failed);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${dataset}.csv`;
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      announce(t.done(name));
    } catch (e) {
      setError((e as Error).message || t.failed);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <details className="export-panel">
      <summary>{t.summary}</summary>
      <p className="mf-hint">{t.hint}</p>
      {ranged && (
        <div className="export-panel__range">
          <TextField label={t.from} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <TextField label={t.to} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} error={badRange ? t.badRange : undefined} />
        </div>
      )}
      <div className="export-panel__actions">
        {datasets.map((d) => (
          <Button key={d} busy={busy === d} disabled={badRange && d !== "stock"} onClick={() => void download(d)}>
            {t.download[d]}
          </Button>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </details>
  );
}
