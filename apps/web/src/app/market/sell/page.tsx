"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, EmptyState, ErrorSummary, Notice, SelectField, StatusPill, TextField } from "@metafarm/ui";
import { SHIPPING_METHODS, type MarketCurrency, type ShippingMethod } from "@metafarm/domain";
import { MarketChrome, Money, NotEnabled, useMarketError } from "@/components/market/MarketChrome";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { listingTone, parseMoney, parseQuantity } from "@/lib/market";

type Eligible = Schemas["MarketEligibleItems"];
type AssetItem = Eligible["assets"][number];
type ProduceItem = Eligible["produce"][number];

/** What this workspace could sell, whether each item is eligible and why not, and its own listings. */
export default function SellPage() {
  const t = useI18n().m.market;
  return (
    <MarketChrome title={t.sell.title}>
      <RequireTenant>{(tenantId) => <Sell tenantId={tenantId} />}</RequireTenant>
    </MarketChrome>
  );
}

function Sell({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.market;
  const can = useCan();
  const allowed = can("market:sell");
  const items = useQuery(allowed ? `market:eligible:${tenantId}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/market/eligible-items", { params: { path: { tenantId } } })));
  const mine = useQuery(allowed ? `market:mine:${tenantId}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/market/listings", { params: { path: { tenantId }, query: { scope: "mine" } } })));
  if (!allowed) return <Notice>{t.sell.notSeller}</Notice>;
  return (
    <>
      <p className="mf-hint">{t.sell.intro}</p>
      {items.loading && !items.data && <p role="status">{t.loading}</p>}
      <NotEnabled error={items.error} />
      {items.data && (
        <>
          <section aria-labelledby="sell-assets">
            <h2 id="sell-assets">{t.sell.assetsHeading}</h2>
            {items.data.assets.length === 0 ? (
              <EmptyState title={t.sell.noAssets} />
            ) : (
              <ul className="tasks">
                {items.data.assets.map((a) => (
                  <li key={a.id}>
                    <AssetRow tenantId={tenantId} item={a} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="sell-produce">
            <h2 id="sell-produce">{t.sell.produceHeading}</h2>
            {items.data.produce.length === 0 ? (
              <EmptyState title={t.sell.noProduce} />
            ) : (
              <ul className="tasks">
                {items.data.produce.map((p) => (
                  <li key={p.id}>
                    <ProduceRow tenantId={tenantId} item={p} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <section aria-labelledby="sell-mine">
        <h2 id="sell-mine">{t.sell.yourListings}</h2>
        {mine.data && mine.data.items.length === 0 && <EmptyState title={t.sell.noListings} />}
        {mine.data && mine.data.items.length > 0 && (
          <ul className="tasks">
            {mine.data.items.map((l) => (
              <li key={l.id} className="market-order-row">
                <StatusPill tone={listingTone(l.status)}>{t.listingStatuses[l.status]}</StatusPill> <Link href={`/market/${l.id}`}>{l.title}</Link> · <Money minor={l.priceMinor} currency={l.currency} />
                {l.kind === "produce" && ` / ${t.units[l.unit] ?? l.unit}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Eligibility({ eligible, reasons }: { eligible: boolean; reasons: string[] }) {
  const t = useI18n().m.market;
  return eligible ? (
    <StatusPill tone="ok">{t.sell.eligible}</StatusPill>
  ) : (
    <span className="market-ineligible">
      <StatusPill tone="neutral">{t.sell.notEligible}</StatusPill> {reasons.map((r) => t.reasons[r] ?? r).join("; ")}
    </span>
  );
}

function AssetRow({ tenantId, item: a }: { tenantId: string; item: AssetItem }) {
  const t = useI18n().m.market;
  const [open, setOpen] = useState(false);
  return (
    <article className="task" aria-labelledby={`asset-${a.id}`}>
      <div className="task__head">
        <h3 id={`asset-${a.id}`} className="task__title">
          {a.name}
        </h3>
        <Eligibility eligible={a.eligible} reasons={a.reasons} />
      </div>
      <p className="task__meta">
        {t.assetKinds[a.kind] ?? a.kind} · {a.farmName}
        {a.externalRef && (
          <>
            {" · "}
            <bdi className="ltr">{a.externalRef}</bdi>
          </>
        )}
        {" · "}
        {a.registeredHere && a.controlSource === "registration" ? t.sell.registeredHere : t.sell.acquired}
      </p>
      {a.eligible && !open && (
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t.sell.listThis}
        </Button>
      )}
      {open && <ListingForm tenantId={tenantId} kind="registered_asset" itemId={a.id} defaultTitle={a.name} onCancel={() => setOpen(false)} />}
    </article>
  );
}

function ProduceRow({ tenantId, item: p }: { tenantId: string; item: ProduceItem }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const [open, setOpen] = useState(false);
  const unit = t.units[p.unit] ?? p.unit;
  return (
    <article className="task" aria-labelledby={`batch-${p.id}`}>
      <div className="task__head">
        <h3 id={`batch-${p.id}`} className="task__title">
          {p.crop}
        </h3>
        <Eligibility eligible={p.eligible} reasons={p.reasons} />
      </div>
      <p className="task__meta">
        <bdi className="ltr harvest__code">{p.code}</bdi> · {t.sell.batchLine(fmt.day(p.harvestedOn), fmt.number(p.quantity, { maximumFractionDigits: 3 }), unit)} · {p.farmName}
      </p>
      {p.eligible && <p className="mf-hint">{t.sell.canStillList(fmt.number(p.available, { maximumFractionDigits: 3 }), unit)}</p>}
      {p.eligible && !open && (
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t.sell.listThis}
        </Button>
      )}
      {open && <ListingForm tenantId={tenantId} kind="produce" itemId={p.id} defaultTitle={p.crop} unit={p.unit} available={p.available} onCancel={() => setOpen(false)} />}
    </article>
  );
}

interface OptionDraft {
  on: boolean;
  fee: string;
  perUnit: string;
}

function ListingForm(props: { tenantId: string; kind: "registered_asset" | "produce"; itemId: string; defaultTitle: string; unit?: string; available?: number; onCancel: () => void }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const router = useRouter();
  const errorText = useMarketError();
  const [title, setTitle] = useState(props.defaultTitle);
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState<MarketCurrency>("IRR");
  const [price, setPrice] = useState("");
  const [pricing, setPricing] = useState<"fixed" | "offers">("fixed");
  const [quantity, setQuantity] = useState(props.available !== undefined ? String(props.available) : "");
  const [options, setOptions] = useState<Record<ShippingMethod, OptionDraft>>({
    pickup: { on: true, fee: "0", perUnit: "0" },
    local_delivery: { on: false, fee: "0", perUnit: "0" },
    courier_manual: { on: false, fee: "0", perUnit: "0" },
  });
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const unit = props.unit ? (t.units[props.unit] ?? props.unit) : "";
  const fee = (s: string) => (s.trim() === "" || s.trim() === "0" || s.trim() === "۰" ? 0 : parseMoney(s, currency));
  const id = (x: string) => `${x}-${props.itemId}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problems: { field?: string; message: string }[] = [];
    const priceMinor = parseMoney(price, currency);
    if (priceMinor === null) problems.push({ field: id("price"), message: t.amountInvalid });
    let q: number | null = null;
    const deliveryOptions: Schemas["MarketDeliveryOption"][] = [];
    if (props.kind === "produce") {
      q = parseQuantity(quantity);
      if (q === null || q > (props.available ?? 0) + 1e-9) problems.push({ field: id("qty"), message: t.quantityInvalid });
      for (const method of SHIPPING_METHODS) {
        const o = options[method];
        if (!o.on) continue;
        const f = method === "pickup" ? 0 : fee(o.fee);
        const pu = method === "pickup" ? 0 : fee(o.perUnit);
        if (f === null || pu === null) problems.push({ field: id(`fee-${method}`), message: t.sell.chooseDelivery });
        else deliveryOptions.push({ method, feeMinor: f, perUnitMinor: pu });
      }
      if (deliveryOptions.length === 0) problems.push({ message: t.sell.chooseDelivery });
    }
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      const base = { title: title.trim(), currency, priceMinor: priceMinor!, ...(description.trim() ? { description: description.trim() } : {}) };
      const body: Schemas["CreateMarketListing"] =
        props.kind === "produce" ? { kind: "produce", harvestBatchId: props.itemId, quantity: q!, deliveryOptions, ...base } : { kind: "registered_asset", assetId: props.itemId, pricing, ...base };
      const l = await unwrap(api.POST("/v1/tenants/{tenantId}/market/listings", { params: { path: { tenantId: props.tenantId } }, body }));
      router.push(`/market/${l.id}`);
    } catch (err) {
      setErrors([{ message: errorText(err) }]);
      setBusy(false);
    }
  }

  return (
    <form className="market-form" onSubmit={submit} noValidate aria-label={`${t.sell.listThis}: ${props.defaultTitle}`}>
      {errors.length > 0 && <ErrorSummary errors={errors} />}
      <TextField label={t.sell.titleLabel} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={160} />
      <TextField label={t.sell.descriptionLabel} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      <SelectField label={t.sell.currency} value={currency} onChange={(e) => setCurrency(e.target.value as MarketCurrency)}>
        <option value="IRR">{t.sell.currencies.IRR}</option>
        <option value="USD">{t.sell.currencies.USD}</option>
      </SelectField>
      {props.kind === "registered_asset" && (
        <SelectField label={t.sell.pricing} value={pricing} onChange={(e) => setPricing(e.target.value as "fixed" | "offers")}>
          <option value="fixed">{t.sell.pricingModes.fixed}</option>
          <option value="offers">{t.sell.pricingModes.offers}</option>
        </SelectField>
      )}
      <TextField
        id={id("price")}
        label={props.kind === "produce" ? t.sell.pricePerUnit(unit, currency) : t.sell.price(currency)}
        inputMode="decimal"
        dir="ltr"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        required
      />
      {props.kind === "produce" && (
        <>
          <TextField
            id={id("qty")}
            label={t.sell.quantityToList(unit)}
            hint={t.sell.canStillList(fmt.number(props.available ?? 0, { maximumFractionDigits: 3 }), unit)}
            inputMode="decimal"
            dir="ltr"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
          />
          <fieldset className="market-methods">
            <legend>{t.sell.deliveryOptions}</legend>
            {SHIPPING_METHODS.map((method) => (
              <div key={method} className="market-option">
                <label className="checkbox-field">
                  <input type="checkbox" checked={options[method].on} onChange={(e) => setOptions((o) => ({ ...o, [method]: { ...o[method], on: e.target.checked } }))} />{" "}
                  {t.sell.offerMethod(t.methods[method]!)}
                </label>
                <p className="mf-hint">{t.methodNotes[method]}</p>
                {options[method].on && method !== "pickup" && (
                  <div className="inline-form">
                    <TextField
                      id={id(`fee-${method}`)}
                      label={t.sell.flatFee(currency)}
                      inputMode="decimal"
                      dir="ltr"
                      value={options[method].fee}
                      onChange={(e) => setOptions((o) => ({ ...o, [method]: { ...o[method], fee: e.target.value } }))}
                    />
                    <TextField
                      label={t.sell.perUnitFee(unit, currency)}
                      inputMode="decimal"
                      dir="ltr"
                      value={options[method].perUnit}
                      onChange={(e) => setOptions((o) => ({ ...o, [method]: { ...o[method], perUnit: e.target.value } }))}
                    />
                  </div>
                )}
              </div>
            ))}
          </fieldset>
        </>
      )}
      <div className="task__actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.sell.submit}
        </Button>
        <Button onClick={props.onCancel}>{t.sell.cancel}</Button>
      </div>
    </form>
  );
}
