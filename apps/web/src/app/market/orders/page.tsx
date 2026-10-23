"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, Notice, StatusPill, VisuallyHidden } from "@metafarm/ui";
import { MarketChrome, Money, NotEnabled, useQty } from "@/components/market/MarketChrome";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { orderTone } from "@/lib/market";

/** The workspace's orders and offers, as buyer and as seller: the transaction history. */
export default function OrdersPage() {
  const t = useI18n().m.market;
  return (
    <MarketChrome title={t.orders.title}>
      <RequireTenant>{(tenantId) => <Orders tenantId={tenantId} />}</RequireTenant>
    </MarketChrome>
  );
}

function Orders({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.market;
  const can = useCan();
  const sides = [...(can("market:buy") ? (["buyer"] as const) : []), ...(can("market:sell") ? (["seller"] as const) : [])];
  const [side, setSide] = useState<"buyer" | "seller">(sides[0] ?? "buyer");
  // `?side=seller` opens the selling tab.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("side");
    if (s === "seller" || s === "buyer") setSide(s);
  }, []);
  const allowed = sides.includes(side as never);
  const q = useQuery(allowed ? `market:orders:${tenantId}:${side}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/market/orders", { params: { path: { tenantId }, query: { side } } })), { pollMs: 15_000 });
  if (sides.length === 0) return <Notice>{t.orders.notAllowed}</Notice>;
  return (
    <>
      <fieldset className="market-filter">
        <legend>
          <VisuallyHidden>{t.orders.title}</VisuallyHidden>
        </legend>
        {sides.map((s) => (
          <label key={s}>
            <input type="radio" name="market-side" value={s} checked={side === s} onChange={() => setSide(s)} /> {s === "buyer" ? t.orders.buying : t.orders.selling}
          </label>
        ))}
      </fieldset>
      {q.loading && !q.data && <p role="status">{t.loading}</p>}
      <NotEnabled error={q.error} />
      {q.data && q.data.items.length === 0 && <EmptyState title={t.orders.none} />}
      {q.data && q.data.items.length > 0 && <OrdersTable items={q.data.items} />}
    </>
  );
}

function OrdersTable({ items }: { items: Schemas["MarketOrder"][] }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const qty = useQty();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t.orders.colItem}</th>
            <th scope="col">{t.orders.colWith}</th>
            <th scope="col">{t.orders.colStatus}</th>
            <th scope="col">{t.orders.colTotal}</th>
            <th scope="col">{t.orders.colUpdated}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td>
                <Link href={`/market/orders/${o.id}`}>{o.listingTitle}</Link>
                <br />
                <span className="mf-hint">{qty(o.quantity, o.unit)}</span>
              </td>
              <td>{o.side === "buyer" ? o.seller.name : o.buyer.name}</td>
              <td>
                <StatusPill tone={orderTone(o.status)}>{t.statuses[o.status]}</StatusPill>
              </td>
              <td>
                <Money minor={o.totalMinor} currency={o.currency} />
              </td>
              <td>
                <time dateTime={o.updatedAt}>{fmt.dateTime(o.updatedAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
