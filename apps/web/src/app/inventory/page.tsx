"use client";
import { Fragment, useState, type FormEvent } from "react";
import { INPUT_CATEGORIES, type InputCategory } from "@metafarm/domain";
import { Button, EmptyState, ErrorSummary, Notice, PageHeader, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";

type Item = Schemas["InputItem"];
const DECIMAL = /^\d{1,11}(\.\d{1,3})?$/;

export default function InventoryPage() {
  const t = useI18n().m.inventory;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <Inventory tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Inventory({ tenantId }: { tenantId: string }) {
  const { m, fmt } = useI18n();
  const t = m.inventory;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string>();
  const items = useQuery(`inventory:${tenantId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/inventory/items", { params: { path: { tenantId } } })),
  );
  const reload = () => setVersion((v) => v + 1);
  const list = items.data?.items ?? [];
  const qty = (q: string, unit: string) => `${fmt.number(Number(q), { maximumFractionDigits: 3 })} ${unit}`;

  return (
    <>
      {items.loading && !items.data && <p role="status">{t.loading}</p>}
      {items.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {items.error.message}
        </Notice>
      )}
      {items.data && list.length === 0 && <EmptyState title={t.none}>{can("inventory:manage") ? t.noneManager : undefined}</EmptyState>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="mf-visually-hidden">{t.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t.colItem}</th>
                <th scope="col">{t.colCategory}</th>
                <th scope="col">{t.colOnHand}</th>
                <th scope="col">{t.colReorder}</th>
                <th scope="col">{t.colLast}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <Fragment key={i.id}>
                  <tr>
                    <th scope="row">
                      {i.name}
                      {i.preHarvestIntervalDays || i.reEntryHours ? (
                        <span className="mf-hint stock-safety">
                          {[i.preHarvestIntervalDays ? t.phi(i.preHarvestIntervalDays) : null, i.reEntryHours ? t.reEntry(i.reEntryHours) : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={open === i.id}
                        onClick={() => setOpen((o) => (o === i.id ? undefined : i.id))}
                      >
                        {open === i.id ? t.history.hide : t.history.show(i.name)}
                      </button>
                    </th>
                    <td>{t.categories[i.category]}</td>
                    <td>
                      <span className={Number(i.onHand) < 0 ? "stock-negative" : undefined}>{qty(i.onHand, i.unit)}</span>{" "}
                      {Number(i.onHand) < 0 ? (
                        <StatusPill tone="problem">{t.negative}</StatusPill>
                      ) : i.lowStock ? (
                        <StatusPill tone="pending">{t.lowStock}</StatusPill>
                      ) : null}
                    </td>
                    <td>{i.reorderLevel ? qty(i.reorderLevel, i.unit) : m.common.none}</td>
                    <td>{i.lastMovementOn ? fmt.day(i.lastMovementOn) : m.common.none}</td>
                  </tr>
                  {open === i.id && (
                    <tr>
                      <td colSpan={5}>
                        <History tenantId={tenantId} item={i} version={version} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can("inventory:manage") && (
        <div className="grid-2" style={{ marginTop: "1.5rem" }}>
          {list.length > 0 && <MovementForm tenantId={tenantId} items={list} onRecorded={reload} />}
          <ItemForm tenantId={tenantId} onAdded={reload} />
        </div>
      )}
    </>
  );
}

function History({ tenantId, item, version }: { tenantId: string; item: Item; version: number }) {
  const { m, fmt } = useI18n();
  const t = m.inventory.history;
  const moves = useQuery(`moves:${item.id}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/inventory/movements", { params: { path: { tenantId }, query: { itemId: item.id, limit: 100 } } })),
  );
  if (!moves.data) return <p role="status">{m.common.loading}</p>;
  if (moves.data.items.length === 0) return <p>{t.none}</p>;
  return (
    <table className="nested-table">
      <caption>{t.caption(item.name)}</caption>
      <thead>
        <tr>
          <th scope="col">{t.colDate}</th>
          <th scope="col">{t.colChange}</th>
          <th scope="col">{t.colWhere}</th>
          <th scope="col">{t.colBy}</th>
          <th scope="col">{t.colDetails}</th>
        </tr>
      </thead>
      <tbody>
        {moves.data.items.map((mv) => (
          <tr key={mv.id}>
            <td>{fmt.day(mv.occurredOn)}</td>
            <td>
              {m.inventory.kinds[mv.kind]}: <span className="ltr">{mv.quantity.startsWith("-") ? "" : "+"}{fmt.number(Number(mv.quantity), { maximumFractionDigits: 3 })}</span> {mv.itemUnit}
            </td>
            <td>{[mv.farmName, mv.parcelLabel].filter(Boolean).join(" · ") || m.common.none}</td>
            <td>{mv.recordedByName ?? m.common.none}</td>
            <td>
              {[mv.taskTitle, mv.supplier, mv.lot, mv.cost && mv.currency ? fmt.currency(Number(mv.cost), mv.currency) : null, mv.note].filter(Boolean).join(" · ") || m.common.none}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemForm({ tenantId, onAdded }: { tenantId: string; onAdded: () => void }) {
  const { m } = useI18n();
  const t = m.inventory.item;
  const announce = useAnnounce();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<InputCategory>("fertilizer");
  const [unit, setUnit] = useState("kg");
  const [reorder, setReorder] = useState("");
  const [phi, setPhi] = useState("");
  const [reEntry, setReEntry] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const whole = (v: string) => (v.trim() === "" ? null : /^\d{1,3}$/.test(v.trim()) ? Number(v) : NaN);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p: { field?: string; message: string }[] = [];
    if (!name.trim()) p.push({ field: "item-name", message: t.nameRequired });
    if (!unit.trim()) p.push({ field: "item-unit", message: t.unitRequired });
    if (reorder.trim() && !DECIMAL.test(reorder.trim())) p.push({ field: "item-reorder", message: m.inventory.numberInvalid });
    if (Number.isNaN(whole(phi))) p.push({ field: "item-phi", message: t.wholeNumber });
    if (Number.isNaN(whole(reEntry))) p.push({ field: "item-reentry", message: t.wholeNumber });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const created = await unwrap(
        api.POST("/v1/tenants/{tenantId}/inventory/items", {
          params: { path: { tenantId } },
          body: {
            name: name.trim(),
            category,
            unit: unit.trim(),
            reorderLevel: reorder.trim() || null,
            preHarvestIntervalDays: whole(phi),
            reEntryHours: whole(reEntry),
            notes: notes.trim() || null,
          },
        }),
      );
      announce(t.added(created.name));
      setName("");
      setReorder("");
      setPhi("");
      setReEntry("");
      setNotes("");
      onAdded();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="item-form-heading">
      <h2 id="item-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <TextField id="item-name" label={t.name} hint={t.nameHint} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={err("item-name")} />
      <SelectField label={t.category} value={category} onChange={(e) => setCategory(e.target.value as InputCategory)}>
        {INPUT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {m.inventory.categories[c]}
          </option>
        ))}
      </SelectField>
      <TextField id="item-unit" label={t.unit} hint={t.unitHint} value={unit} maxLength={16} onChange={(e) => setUnit(e.target.value)} error={err("item-unit")} />
      <TextField id="item-reorder" label={t.reorder} hint={t.reorderHint} inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} error={err("item-reorder")} />
      {category === "crop-protection" && (
        <>
          <TextField id="item-phi" label={t.phi} hint={t.phiHint} inputMode="numeric" value={phi} onChange={(e) => setPhi(e.target.value)} error={err("item-phi")} />
          <TextField id="item-reentry" label={t.reEntry} inputMode="numeric" value={reEntry} onChange={(e) => setReEntry(e.target.value)} error={err("item-reentry")} />
        </>
      )}
      <TextField label={t.notes} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}

function MovementForm({ tenantId, items, onRecorded }: { tenantId: string; items: Item[]; onRecorded: () => void }) {
  const { m } = useI18n();
  const t = m.inventory.move;
  const announce = useAnnounce();
  const [itemId, setItemId] = useState("");
  const [kind, setKind] = useState<"receive" | "adjust">("receive");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(localToday());
  const [supplier, setSupplier] = useState("");
  const [lot, setLot] = useState("");
  const [expires, setExpires] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("IRR");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const unit = items.find((i) => i.id === itemId)?.unit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = quantity.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!itemId) p.push({ field: "move-item", message: t.itemRequired });
    const qOk = kind === "receive" ? DECIMAL.test(q) && Number(q) > 0 : /^-?\d{1,11}(\.\d{1,3})?$/.test(q) && Number(q) !== 0;
    if (!qOk) p.push({ field: "move-qty", message: m.inventory.numberInvalid });
    if (kind === "adjust" && note.trim().length < 3) p.push({ field: "move-note", message: t.noteRequired });
    if (kind === "receive" && cost.trim() && !/^\d{1,13}(\.\d{1,2})?$/.test(cost.trim())) p.push({ field: "move-cost", message: m.inventory.numberInvalid });
    if (kind === "receive" && cost.trim() && !/^[A-Z]{3}$/.test(currency.trim())) p.push({ field: "move-currency", message: t.costCurrency });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const body: Schemas["StockMovementInput"] =
        kind === "receive"
          ? {
              kind,
              itemId,
              quantity: q,
              occurredOn: date,
              supplier: supplier.trim() || null,
              lot: lot.trim() || null,
              expiresOn: expires || null,
              cost: cost.trim() || null,
              currency: cost.trim() ? currency.trim() : null,
              note: note.trim() || null,
            }
          : { kind, itemId, quantity: q, occurredOn: date, note: note.trim() };
      await unwrap(api.POST("/v1/tenants/{tenantId}/inventory/movements", { params: { path: { tenantId } }, body }));
      announce(t.recorded);
      setQuantity("");
      setNote("");
      setLot("");
      setCost("");
      onRecorded();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="move-form-heading">
      <h2 id="move-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <SelectField id="move-item" label={t.item} value={itemId} onChange={(e) => setItemId(e.target.value)} error={err("move-item")}>
        <option value="">{t.choose}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name} ({i.unit})
          </option>
        ))}
      </SelectField>
      <SelectField label={t.kind} value={kind} onChange={(e) => setKind(e.target.value as "receive" | "adjust")}>
        <option value="receive">{t.receive}</option>
        <option value="adjust">{t.adjust}</option>
      </SelectField>
      <TextField
        id="move-qty"
        label={unit ? `${t.quantity} (${unit})` : t.quantity}
        hint={kind === "adjust" ? t.adjustHint : undefined}
        inputMode="decimal"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        error={err("move-qty")}
      />
      <TextField label={t.date} type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
      {kind === "receive" && (
        <>
          <TextField label={t.supplier} value={supplier} maxLength={120} onChange={(e) => setSupplier(e.target.value)} />
          <TextField label={t.lot} value={lot} maxLength={60} onChange={(e) => setLot(e.target.value)} />
          <TextField label={t.expires} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          <div className="grid-2">
            <TextField id="move-cost" label={t.cost} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} error={err("move-cost")} />
            <TextField
              id="move-currency"
              label={t.currency}
              hint={t.currencyHint}
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              error={err("move-currency")}
            />
          </div>
        </>
      )}
      <TextField id="move-note" label={kind === "adjust" ? t.note : t.noteOptional} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} error={err("move-note")} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
