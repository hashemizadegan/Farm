"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, ErrorSummary, Notice, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { deliveryEstimate, lineTotal, needsAddress, type ShippingMethod } from "@metafarm/domain";
import { MarketChrome, Money, NotEnabled, useMarketError, useQty } from "@/components/market/MarketChrome";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { listingTone, orderTone, parseMoney, parseQuantity } from "@/lib/market";

type Detail = Schemas["MarketListingDetail"];

/** One listing: what it is, where it comes from (provenance and current checks), and how to order it (simulation). */
export default function ListingPage() {
  const { listingId } = useParams<{ listingId: string }>();
  return (
    <MarketChrome>
      <RequireTenant>{(tenantId) => <Listing tenantId={tenantId} listingId={listingId} />}</RequireTenant>
    </MarketChrome>
  );
}

function Listing({ tenantId, listingId }: { tenantId: string; listingId: string }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const [version, setVersion] = useState(0);
  const q = useQuery(`market:listing:${tenantId}:${listingId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/market/listings/{listingId}", { params: { path: { tenantId, listingId } } })),
  );
  const back = (
    <p>
      <Link href="/market">{t.backToCatalogue}</Link>
    </p>
  );
  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  if (q.error?.status === 404 && q.error.body?.error !== "marketplace_not_enabled") {
    return (
      <>
        <Notice tone="error">{t.notFound}</Notice>
        {back}
      </>
    );
  }
  if (q.error || !q.data) return <NotEnabled error={q.error} />;
  const l = q.data;
  return (
    <>
      {back}
      <div className="market-detail__head">
        <StatusPill tone="neutral">{t.kinds[l.kind]}</StatusPill>
        <StatusPill tone={listingTone(l.status)}>{t.listingStatuses[l.status]}</StatusPill>
        {l.mine && <StatusPill tone="pending">{t.yourListing}</StatusPill>}
      </div>
      <h2 className="market-detail__title">{l.title}</h2>
      <div className="card">
        <dl className="facts">
          <div>
            <dt>{t.price}</dt>
            <dd>
              <Money minor={l.priceMinor} currency={l.currency} />
              {l.kind === "produce" && ` / ${t.units[l.unit] ?? l.unit}`}
            </dd>
          </div>
          <div>
            <dt>{t.seller}</dt>
            <dd>{l.seller.name}</dd>
          </div>
          <div>
            <dt>{l.kind === "produce" ? t.batch.quantity : t.sell.pricing}</dt>
            <dd>
              {l.kind === "produce"
                ? t.available(fmt.number(l.quantityAvailable, { maximumFractionDigits: 3 }), t.units[l.unit] ?? l.unit)
                : l.pricing === "offers"
                  ? t.offersWelcome
                  : t.fixedPrice}
            </dd>
          </div>
        </dl>
        {l.description && (
          <>
            <h3>{t.description}</h3>
            <p>{l.description}</p>
          </>
        )}
      </div>

      <div className="grid-2 market-detail__body">
        <Provenance listing={l} />
        {l.mine ? <SellerPanel tenantId={tenantId} listing={l} onChanged={() => setVersion((v) => v + 1)} /> : <BuyPanel tenantId={tenantId} listing={l} />}
      </div>

      {l.orders.length > 0 && (
        <section className="card" aria-labelledby="listing-orders">
          <h3 id="listing-orders">{l.mine ? t.ordersOnListing : t.yourOrdersOnListing}</h3>
          <OrderList orders={l.orders} />
        </section>
      )}
    </>
  );
}

function Provenance({ listing: l }: { listing: Detail }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const p = l.provenance;
  const fact = (label: string, value: ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    );
  return (
    <section className="card" aria-labelledby="provenance-heading">
      <h3 id="provenance-heading">{t.provenance}</h3>
      <p className="mf-hint">{t.provenanceIntro}</p>
      {p.kind === "registered_asset" ? (
        <dl className="facts">
          {fact(t.asset.name, p.assetName)}
          {fact(t.asset.kind, t.assetKinds[p.assetKind ?? ""] ?? p.assetKind)}
          {fact(t.asset.ref, p.externalRef ? <bdi className="ltr">{p.externalRef}</bdi> : null)}
          {fact(t.asset.farm, p.farmName)}
          {fact(t.asset.registeredBy, p.registeredBy)}
          {fact(t.asset.verifiedAt, p.verifiedAt ? fmt.dateTime(p.verifiedAt) : null)}
          {fact(t.asset.controlledBy, l.current.controlledBy ?? p.controlledBy)}
          {fact(t.asset.controlSource, t.asset.sources[p.controlSource ?? ""] ?? p.controlSource)}
        </dl>
      ) : (
        <dl className="facts">
          {fact(
            t.batch.code,
            p.code ? (
              <>
                <bdi className="ltr harvest__code">{p.code}</bdi> · <Link href={`/verify/${p.code}`}>{t.batch.verify}</Link>
              </>
            ) : null,
          )}
          {fact(t.batch.crop, p.crop)}
          {fact(t.batch.harvestedOn, p.harvestedOn ? fmt.day(p.harvestedOn) : null)}
          {fact(t.batch.quantity, p.batchQuantity !== undefined ? `${fmt.number(p.batchQuantity, { maximumFractionDigits: 3 })} ${t.units[p.unit ?? ""] ?? p.unit}` : null)}
          {fact(t.batch.grade, p.qualityGrade)}
          {fact(t.batch.producer, p.producer)}
          {fact(t.batch.farm, p.farmName)}
          {fact(t.batch.hash, p.recordHash ? <code className="ltr market-hash">{p.recordHash}</code> : null)}
        </dl>
      )}
      <h4>{t.checkedNow}</h4>
      <ul className="market-checks">
        {Object.entries(l.current.checks).map(([k, ok]) => (
          <li key={k} data-ok={ok}>
            <StatusPill tone={ok ? "ok" : "problem"}>{ok ? t.checkYes : t.checkNo}</StatusPill> {t.checks[k] ?? k}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SellerPanel({ tenantId, listing: l, onChanged }: { tenantId: string; listing: Detail; onChanged: () => void }) {
  const t = useI18n().m.market;
  const can = useCan();
  const announce = useAnnounce();
  const errorText = useMarketError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function withdraw() {
    if (!window.confirm(t.withdrawConfirm)) return;
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/market/listings/{listingId}/withdraw", { params: { path: { tenantId, listingId: l.id } } }));
      announce(t.withdrawn);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="seller-panel">
      <h3 id="seller-panel">{t.ownListing}</h3>
      {error && <Notice tone="error">{error}</Notice>}
      {can("market:sell") && (l.status === "active" || l.status === "sold_out" || l.status === "reserved") && (
        <Button variant="danger" busy={busy} onClick={withdraw}>
          {t.withdraw}
        </Button>
      )}
    </section>
  );
}

const EMPTY_ADDRESS = { recipient: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "IR", phone: "" };

function BuyPanel({ tenantId, listing: l }: { tenantId: string; listing: Detail }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const can = useCan();
  const router = useRouter();
  const errorText = useMarketError();
  const [quantity, setQuantity] = useState("1");
  const [offer, setOffer] = useState("");
  const [method, setMethod] = useState<ShippingMethod | "">(l.deliveryOptions[0]?.method ?? "");
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const unit = t.units[l.unit] ?? l.unit;

  const q = l.kind === "produce" ? parseQuantity(quantity) : 1;
  const quantityOk = q !== null && q <= l.quantityAvailable + 1e-9;
  const estimate = useMemo(() => {
    if (l.kind !== "produce" || !quantityOk || !method) return null;
    const delivery = deliveryEstimate(l.deliveryOptions, method, q!);
    return delivery === null ? null : { subtotal: lineTotal(l.priceMinor, q!), delivery };
  }, [l, q, quantityOk, method]);

  if (!can("market:buy")) return <Notice>{t.notBuyer}</Notice>;
  if (l.status !== "active") return <Notice>{t.unavailable}</Notice>;

  const offers = l.kind === "registered_asset" && l.pricing === "offers";
  const addressOk = () =>
    Boolean(address.recipient.trim() && address.line1.trim() && address.city.trim() && address.postalCode.trim().length >= 3 && /^[A-Za-z]{2}$/.test(address.country.trim()) && /^\+?[0-9 ()-]{6,24}$/.test(address.phone.trim()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problems: { field?: string; message: string }[] = [];
    let offerMinor: number | null = null;
    if (l.kind === "produce") {
      if (!quantityOk) problems.push({ field: "market-qty", message: t.quantityInvalid });
      if (method && needsAddress(method) && !addressOk()) problems.push({ field: "market-recipient", message: t.addressInvalid });
    }
    if (offers) {
      offerMinor = parseMoney(offer, l.currency);
      if (offerMinor === null) problems.push({ field: "market-offer", message: t.amountInvalid });
    }
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      const trimmed = Object.fromEntries(Object.entries(address).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== "")) as typeof address;
      const body: Schemas["PlaceMarketOrder"] = {
        listingId: l.id,
        ...(l.kind === "produce" ? { quantity: q!, delivery: { method: method as ShippingMethod, ...(method && needsAddress(method) ? { address: trimmed } : {}) } } : {}),
        ...(offerMinor !== null ? { offerMinor } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      const o = await unwrap(api.POST("/v1/tenants/{tenantId}/market/orders", { params: { path: { tenantId } }, body }));
      router.push(`/market/orders/${o.id}`);
    } catch (err) {
      setErrors([{ message: errorText(err) }]);
      setBusy(false);
    }
  }

  const field = (key: keyof typeof EMPTY_ADDRESS, label: string, required: boolean, extra: Record<string, unknown> = {}) => (
    <TextField
      id={key === "recipient" ? "market-recipient" : undefined}
      label={label}
      required={required}
      value={address[key]}
      onChange={(e) => setAddress((a) => ({ ...a, [key]: e.target.value }))}
      {...extra}
    />
  );

  return (
    <section className="card" aria-labelledby="buy-panel">
      <h3 id="buy-panel">{offers ? t.offerHeading : t.buyHeading}</h3>
      <form onSubmit={submit} noValidate aria-label={offers ? t.offerHeading : t.buyHeading}>
        {errors.length > 0 && <ErrorSummary errors={errors} />}
        {l.kind === "produce" && (
          <>
            <TextField
              id="market-qty"
              label={t.quantity(unit)}
              hint={t.quantityHint(fmt.number(l.quantityAvailable, { maximumFractionDigits: 3 }), unit)}
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
            <fieldset className="market-methods">
              <legend>{t.deliveryMethod}</legend>
              {l.deliveryOptions.map((o) => {
                const cost = quantityOk ? deliveryEstimate(l.deliveryOptions, o.method, q!) : null;
                return (
                  <label key={o.method} className="market-method">
                    <input type="radio" name="market-method" value={o.method} checked={method === o.method} onChange={() => setMethod(o.method)} />
                    <span>
                      <strong>{t.methods[o.method]}</strong>
                      {" — "}
                      {cost === null ? "" : cost === 0 ? t.free : <Money minor={cost} currency={l.currency} />}
                      <br />
                      <span className="mf-hint">{t.methodNotes[o.method]}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {method && needsAddress(method) && (
              <fieldset className="market-address">
                <legend>{t.address.heading}</legend>
                {field("recipient", t.address.recipient, true, { autoComplete: "name" })}
                {field("line1", t.address.line1, true, { autoComplete: "address-line1" })}
                {field("line2", t.address.line2, false, { autoComplete: "address-line2" })}
                {field("city", t.address.city, true, { autoComplete: "address-level2" })}
                {field("region", t.address.region, false, { autoComplete: "address-level1" })}
                {field("postalCode", t.address.postalCode, true, { autoComplete: "postal-code", dir: "ltr" })}
                {field("country", t.address.country, true, { autoComplete: "country", dir: "ltr", maxLength: 2 })}
                {field("phone", t.address.phone, true, { autoComplete: "tel", inputMode: "tel", dir: "ltr" })}
              </fieldset>
            )}
            {estimate && (
              <dl className="market-summary" aria-live="polite">
                <div>
                  <dt>{t.summary.subtotal}</dt>
                  <dd>
                    <Money minor={estimate.subtotal} currency={l.currency} />
                  </dd>
                </div>
                <div>
                  <dt>{t.summary.delivery}</dt>
                  <dd>{estimate.delivery === 0 ? t.free : <Money minor={estimate.delivery} currency={l.currency} />}</dd>
                </div>
                <div className="market-summary__total">
                  <dt>{t.summary.total}</dt>
                  <dd>
                    <Money minor={estimate.subtotal + estimate.delivery} currency={l.currency} />
                  </dd>
                </div>
              </dl>
            )}
          </>
        )}
        {offers && <TextField id="market-offer" label={t.offerAmount(l.currency)} inputMode="decimal" value={offer} onChange={(e) => setOffer(e.target.value)} required dir="ltr" />}
        {l.kind === "registered_asset" && !offers && (
          <dl className="market-summary">
            <div className="market-summary__total">
              <dt>{t.summary.total}</dt>
              <dd>
                <Money minor={l.priceMinor} currency={l.currency} />
              </dd>
            </div>
          </dl>
        )}
        <TextField label={t.noteLabel} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <Button type="submit" variant="primary" busy={busy}>
          {l.kind === "produce" ? t.placeOrder : offers ? t.placeOffer : t.orderFixed}
        </Button>
      </form>
    </section>
  );
}

function OrderList({ orders }: { orders: Schemas["MarketOrder"][] }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const qty = useQty();
  return (
    <ul className="tasks">
      {orders.map((o) => (
        <li key={o.id} className="market-order-row">
          <StatusPill tone={orderTone(o.status)}>{t.statuses[o.status]}</StatusPill> <span>{o.side === "seller" ? o.buyer.name : o.seller.name}</span> ·{" "}
          <span>{qty(o.quantity, o.unit)}</span> · <Money minor={o.totalMinor} currency={o.currency} /> · <time dateTime={o.updatedAt}>{fmt.dateTime(o.updatedAt)}</time> ·{" "}
          <Link href={`/market/orders/${o.id}`}>{t.viewOrder}</Link>
        </li>
      ))}
    </ul>
  );
}
