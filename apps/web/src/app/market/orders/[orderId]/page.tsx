"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import type { MarketOrderAction } from "@metafarm/domain";
import { MarketChrome, Money, NotEnabled, useMarketError, useQty } from "@/components/market/MarketChrome";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { CONFIRM_ACTIONS, ORDER_STEPS, orderTone, stepIndex } from "@/lib/market";

type Order = Schemas["MarketOrderDetail"];
const TRACKING = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,63}$/;

/** One order: amounts, delivery, progress, the actions this workspace can take now, and the full audit trail. */
export default function OrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const t = useI18n().m.market;
  return (
    <MarketChrome title={t.order.title}>
      <RequireTenant>{(tenantId) => <OrderView tenantId={tenantId} orderId={orderId} />}</RequireTenant>
    </MarketChrome>
  );
}

function OrderView({ tenantId, orderId }: { tenantId: string; orderId: string }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const qty = useQty();
  const [version, setVersion] = useState(0);
  // The other party acts from their own workspace: poll so their steps show up without a reload.
  const q = useQuery(`market:order:${tenantId}:${orderId}:${version}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/market/orders/{orderId}", { params: { path: { tenantId, orderId } } })), { pollMs: 10_000 });
  const back = (
    <p>
      <Link href="/market/orders">{t.order.back}</Link>
    </p>
  );
  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  if (q.error?.status === 404 && q.error.body?.error !== "marketplace_not_enabled") {
    return (
      <>
        <Notice tone="error">{t.order.notFound}</Notice>
        {back}
      </>
    );
  }
  if (q.error || !q.data) return <NotEnabled error={q.error} />;
  const o = q.data;
  const counterpart = o.side === "buyer" ? o.seller.name : o.buyer.name;
  return (
    <>
      {back}
      <h2 className="market-detail__title">
        <Link href={`/market/${o.listingId}`}>{o.listingTitle}</Link>
      </h2>
      <p className="market-detail__head">
        <StatusPill tone={orderTone(o.status)}>{t.statuses[o.status]}</StatusPill> <span>{t.order.youAre[o.side]}</span> · <span>{counterpart}</span>
      </p>
      <Progress order={o} />
      <div className="grid-2 market-detail__body">
        <section className="card" aria-labelledby="order-amounts">
          <h3 id="order-amounts">{t.kinds[o.kind]}</h3>
          <dl className="facts">
            <div>
              <dt>{t.order.buyer}</dt>
              <dd>
                {o.buyer.name}
                {o.buyer.userName && <span className="mf-hint"> ({o.buyer.userName})</span>}
              </dd>
            </div>
            <div>
              <dt>{t.order.seller}</dt>
              <dd>{o.seller.name}</dd>
            </div>
            <div>
              <dt>{t.order.quantity}</dt>
              <dd>{qty(o.quantity, o.unit)}</dd>
            </div>
            <div>
              <dt>{o.isOffer ? t.order.offered : t.order.unitPrice}</dt>
              <dd>
                <Money minor={o.unitPriceMinor} currency={o.currency} />
              </dd>
            </div>
            <div>
              <dt>{t.order.subtotal}</dt>
              <dd>
                <Money minor={o.subtotalMinor} currency={o.currency} />
              </dd>
            </div>
            {o.kind === "produce" && (
              <div>
                <dt>{t.order.delivery}</dt>
                <dd>{o.deliveryMinor === 0 ? t.free : <Money minor={o.deliveryMinor} currency={o.currency} />}</dd>
              </div>
            )}
            <div>
              <dt>{t.order.total}</dt>
              <dd>
                <Money minor={o.totalMinor} currency={o.currency} />
              </dd>
            </div>
            <div>
              <dt>{t.order.placedAt}</dt>
              <dd>
                <time dateTime={o.createdAt}>{fmt.dateTime(o.createdAt)}</time>
              </dd>
            </div>
          </dl>
          {o.note && <p className="mf-hint">{o.note}</p>}
        </section>
        <Delivery order={o} />
      </div>
      <Actions tenantId={tenantId} order={o} onDone={() => setVersion((v) => v + 1)} />
      <History order={o} />
    </>
  );
}

function Progress({ order: o }: { order: Order }) {
  const t = useI18n().m.market;
  const steps = ORDER_STEPS[o.kind].filter((s) => o.isOffer || s !== "offer_pending");
  const at = stepIndex(o.kind, o.status);
  const current = steps.indexOf(o.status);
  return (
    <section aria-labelledby="order-progress" className="market-progress-wrap">
      <h3 id="order-progress">{t.order.progress}</h3>
      {at === -1 ? (
        <Notice>{t.order.ended}</Notice>
      ) : (
        <ol className="market-progress">
          {steps.map((s, i) => (
            <li key={s} data-state={i < current ? "done" : i === current ? "current" : "todo"} aria-current={i === current ? "step" : undefined}>
              {t.statuses[s]}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Delivery({ order: o }: { order: Order }) {
  const t = useI18n().m.market;
  if (o.kind !== "produce" || !o.delivery) {
    return (
      <section className="card" aria-labelledby="order-delivery">
        <h3 id="order-delivery">{t.order.deliveryHeading}</h3>
        <p>{t.order.assetNote}</p>
      </section>
    );
  }
  const d = o.delivery;
  const a = d.address;
  return (
    <section className="card" aria-labelledby="order-delivery">
      <h3 id="order-delivery">{t.order.deliveryHeading}</h3>
      <dl className="facts">
        <div>
          <dt>{t.order.method}</dt>
          <dd>{t.methods[d.method]}</dd>
        </div>
        {a && (
          <div>
            <dt>{t.order.address}</dt>
            <dd>
              <address className="market-address-view">
                {a.recipient}
                <br />
                {a.line1}
                {a.line2 && (
                  <>
                    <br />
                    {a.line2}
                  </>
                )}
                <br />
                {[a.city, a.region].filter(Boolean).join(", ")} <bdi className="ltr">{a.postalCode}</bdi> <bdi className="ltr">{a.country}</bdi>
                <br />
                <bdi className="ltr">{a.phone}</bdi>
              </address>
            </dd>
          </div>
        )}
        <div>
          <dt>{t.order.carrier}</dt>
          <dd>{d.carrier ?? t.order.notDispatched}</dd>
        </div>
        <div>
          <dt>{t.order.tracking}</dt>
          <dd>{d.trackingRef ? <bdi className="ltr">{d.trackingRef}</bdi> : t.order.notDispatched}</dd>
        </div>
      </dl>
      {d.method !== "pickup" && <p className="mf-hint">{t.order.manualNote}</p>}
    </section>
  );
}

function Actions({ tenantId, order: o, onDone }: { tenantId: string; order: Order; onDone: () => void }) {
  const t = useI18n().m.market;
  const announce = useAnnounce();
  const errorText = useMarketError();
  const [busy, setBusy] = useState<MarketOrderAction | null>(null);
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");

  async function run(action: MarketOrderAction, e?: FormEvent) {
    e?.preventDefault();
    const label = t.actions[action] ?? action;
    if (action === "dispatch" && (carrier.trim().length < 2 || !TRACKING.test(tracking.trim()))) {
      setErrors([{ field: "dispatch-carrier", message: t.dispatchInvalid }]);
      return;
    }
    if (CONFIRM_ACTIONS.has(action) && !window.confirm(t.confirm(label))) return;
    setBusy(action);
    setErrors([]);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/market/orders/{orderId}/actions", {
          params: { path: { tenantId, orderId: o.id } },
          body: action === "dispatch" ? { action, carrier: carrier.trim(), trackingRef: tracking.trim() } : { action },
        }),
      );
      announce(`${label}: ${t.order.done}`);
      onDone();
    } catch (err) {
      setErrors([{ message: errorText(err) }]);
    } finally {
      setBusy(null);
    }
  }

  const actions = o.availableActions;
  return (
    <section className="card market-actions" aria-labelledby="order-actions">
      <h3 id="order-actions">{t.order.actionsHeading}</h3>
      {errors.length > 0 && <ErrorSummary errors={errors} />}
      {actions.length === 0 && <p>{t.order.noActions}</p>}
      <ul className="tasks">
        {actions.map((a) => (
          <li key={a}>
            {a === "dispatch" ? (
              <form onSubmit={(e) => run("dispatch", e)} noValidate aria-label={t.actions.dispatch} className="market-form">
                <p className="mf-hint">{t.actionHints.dispatch}</p>
                <TextField id="dispatch-carrier" label={t.dispatchCarrier} value={carrier} onChange={(e) => setCarrier(e.target.value)} required maxLength={80} />
                <TextField label={t.dispatchTracking} value={tracking} onChange={(e) => setTracking(e.target.value)} required maxLength={64} dir="ltr" />
                <Button type="submit" variant="primary" busy={busy === "dispatch"}>
                  {t.actions.dispatch}
                </Button>
              </form>
            ) : (
              <div className="market-action">
                <Button variant={a === "decline" || a === "cancel" || a === "refund" || a === "withdraw_offer" ? "danger" : "primary"} busy={busy === a} disabled={busy !== null && busy !== a} onClick={() => run(a)}>
                  {t.actions[a]}
                </Button>
                <span className="mf-hint">{t.actionHints[a]}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ order: o }: { order: Order }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  return (
    <section className="card" aria-labelledby="order-history">
      <h3 id="order-history">{t.order.history}</h3>
      <ol className="market-history">
        {o.events.map((e) => {
          const d = e.detail as { carrier?: string; trackingRef?: string; controlledBy?: string; reason?: string };
          return (
            <li key={e.id}>
              <time dateTime={e.at}>{fmt.dateTime(e.at)}</time> · <strong>{t.order.events[e.action] ?? e.action}</strong> · {t.order.sides[e.actorSide]}
              {e.actorName && ` (${e.actorName})`} → <StatusPill tone={orderTone(e.toStatus as Order["status"])}>{t.statuses[e.toStatus] ?? e.toStatus}</StatusPill>
              {d.carrier && d.trackingRef && <span className="mf-hint"> · {t.order.shipped(d.carrier, d.trackingRef)}</span>}
              {d.controlledBy && <span className="mf-hint"> · {t.order.controlledBy(d.controlledBy)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
