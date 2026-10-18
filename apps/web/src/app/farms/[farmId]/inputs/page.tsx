"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, EmptyState, ErrorSummary, Notice, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { ExportPanel } from "@/components/ExportPanel";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday, shiftDay } from "@/lib/dates";

export default function FarmInputsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.farmInputs;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <FarmInputs tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function FarmInputs({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const { m, fmt } = useI18n();
  const t = m.farmInputs;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const log = useQuery(`farm-inputs:${farmId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/inventory/movements", { params: { path: { tenantId }, query: { farmId, kind: "use", limit: 500 } } })),
  );
  const items = useQuery(`inventory:${tenantId}:for-use:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/inventory/items", { params: { path: { tenantId } } })),
  );
  const phiDays = new Map((items.data?.items ?? []).map((i) => [i.id, i.preHarvestIntervalDays ?? 0]));
  const rows = log.data?.items ?? [];

  return (
    <>
      {rows.length > 0 && <ExportPanel tenantId={tenantId} farmId={farmId} datasets={["input-log"]} />}
      {can("inventory:use") &&
        (items.data && items.data.items.length === 0 ? (
          <Notice>
            {t.noItems} {can("inventory:manage") && <Link href="/inventory">{m.inventory.open}</Link>}
          </Notice>
        ) : (
          items.data && <UseForm tenantId={tenantId} farmId={farmId} items={items.data.items} onRecorded={() => setVersion((v) => v + 1)} />
        ))}
      {log.loading && !log.data && <p role="status">{m.common.loading}</p>}
      {log.error && <Notice tone="error">{log.error.message}</Notice>}
      {log.data && rows.length === 0 && <EmptyState title={t.none} />}
      {rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: "1.5rem" }}>
          <table>
            <caption>{t.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t.colDate}</th>
                <th scope="col">{t.colProduct}</th>
                <th scope="col">{t.colQuantity}</th>
                <th scope="col">{t.colParcel}</th>
                <th scope="col">{t.colTask}</th>
                <th scope="col">{t.colBy}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const phi = phiDays.get(r.itemId) ?? 0;
                const until = phi > 0 ? shiftDay(r.occurredOn, phi) : null;
                return (
                  <tr key={r.id}>
                    <td>{fmt.day(r.occurredOn)}</td>
                    <th scope="row">
                      {r.itemName}
                      {until && until > localToday() && <span className="mf-hint stock-safety">{t.phiUntil(fmt.day(until))}</span>}
                    </th>
                    <td>
                      {fmt.number(Math.abs(Number(r.quantity)), { maximumFractionDigits: 3 })} {r.itemUnit}
                    </td>
                    <td>{r.parcelLabel ?? t.allParcels}</td>
                    <td>{r.taskTitle ?? m.common.none}</td>
                    <td>{r.recordedByName ?? m.common.none}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function UseForm({ tenantId, farmId, items, onRecorded }: { tenantId: string; farmId: string; items: Schemas["InputItem"][]; onRecorded: () => void }) {
  const { m } = useI18n();
  const t = m.farmInputs;
  const announce = useAnnounce();
  const plan = useQuery(`plan:${farmId}:labels`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch(() => null),
  );
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [parcel, setParcel] = useState("");
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const unit = items.find((i) => i.id === itemId)?.unit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = quantity.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!itemId) p.push({ field: "use-item", message: t.itemRequired });
    if (!/^\d{1,11}(\.\d{1,3})?$/.test(q) || !(Number(q) > 0)) p.push({ field: "use-qty", message: m.inventory.numberInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/inventory/movements", {
          params: { path: { tenantId } },
          body: { kind: "use", itemId, quantity: q, occurredOn: date, farmId, parcelLabel: parcel.trim() || null, note: note.trim() || null },
        }),
      );
      announce(t.recorded);
      setQuantity("");
      setNote("");
      onRecorded();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="use-heading">
      <h2 id="use-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <SelectField id="use-item" label={t.item} value={itemId} onChange={(e) => setItemId(e.target.value)} error={err("use-item")}>
          <option value="">{t.choose}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.unit})
            </option>
          ))}
        </SelectField>
        <TextField
          id="use-qty"
          label={unit ? `${t.quantity} (${unit})` : t.quantity}
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          error={err("use-qty")}
        />
        <TextField label={t.parcel} list="use-parcels" value={parcel} maxLength={80} onChange={(e) => setParcel(e.target.value)} />
        <datalist id="use-parcels">
          {(plan.data?.parcels ?? []).map((p) => (
            <option key={p.label} value={p.label} />
          ))}
        </datalist>
        <TextField label={t.date} type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
      </div>
      <TextField label={t.note} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
