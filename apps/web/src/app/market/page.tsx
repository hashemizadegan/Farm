"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, StatusPill } from "@metafarm/ui";
import { MarketChrome, Money, NotEnabled } from "@/components/market/MarketChrome";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { listingTone } from "@/lib/market";

type Listing = Schemas["MarketListing"];
type Filter = "all" | "registered_asset" | "produce";

/** The marketplace catalogue: every workspace's public listings, registered assets and farm produce (simulation). */
export default function MarketPage() {
  return (
    <MarketChrome>
      <RequireTenant>{(tenantId) => <Catalogue tenantId={tenantId} />}</RequireTenant>
    </MarketChrome>
  );
}

function Catalogue({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.market;
  const [filter, setFilter] = useState<Filter>("all");
  const q = useQuery(`market:catalogue:${tenantId}:${filter}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/market/listings", { params: { path: { tenantId }, query: filter === "all" ? { scope: "catalogue" } : { scope: "catalogue", kind: filter } } })),
  );
  return (
    <>
      <p className="mf-hint">{t.intro}</p>
      <fieldset className="market-filter">
        <legend>{t.filterLabel}</legend>
        {(["all", "registered_asset", "produce"] as const).map((f) => (
          <label key={f}>
            <input type="radio" name="market-filter" value={f} checked={filter === f} onChange={() => setFilter(f)} /> {t.filters[f]}
          </label>
        ))}
      </fieldset>
      {q.loading && !q.data && <p role="status">{t.loading}</p>}
      <NotEnabled error={q.error} />
      {q.data && q.data.items.length === 0 && <EmptyState title={t.none} />}
      {q.data && q.data.items.length > 0 && (
        <ul className="market-grid" aria-label={t.sections.catalogue}>
          {q.data.items.map((l) => (
            <li key={l.id}>
              <ListingCard listing={l} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ListingCard({ listing: l }: { listing: Listing }) {
  const { m, fmt } = useI18n();
  const t = m.market;
  const p = l.provenance;
  const qtyAvailable = t.available(fmt.number(l.quantityAvailable, { maximumFractionDigits: 3 }), t.units[l.unit] ?? l.unit);
  return (
    <article className="market-card" aria-labelledby={`listing-${l.id}`}>
      <div className="market-card__tags">
        <StatusPill tone="neutral">{t.kinds[l.kind]}</StatusPill>
        {l.status !== "active" && <StatusPill tone={listingTone(l.status)}>{t.listingStatuses[l.status]}</StatusPill>}
        {l.mine && <StatusPill tone="pending">{t.yourListing}</StatusPill>}
      </div>
      <h2 id={`listing-${l.id}`} className="market-card__title">
        <Link href={`/market/${l.id}`}>{l.title}</Link>
      </h2>
      <p className="market-card__meta">
        {l.kind === "produce" ? `${p.crop ?? ""} · ${p.farmName ?? ""}` : `${t.assetKinds[p.assetKind ?? ""] ?? p.assetKind ?? ""} · ${p.farmName ?? ""}`}
      </p>
      <p className="market-card__price">
        <Money minor={l.priceMinor} currency={l.currency} />
        {l.kind === "produce" && <span className="mf-hint"> / {t.units[l.unit] ?? l.unit}</span>}
      </p>
      <p className="mf-hint">
        {l.kind === "produce" ? qtyAvailable : l.pricing === "offers" ? t.offersWelcome : t.fixedPrice}
      </p>
      <p className="market-card__seller">
        {t.seller}: {l.seller.name}
      </p>
    </article>
  );
}
