"use client";
import { EmptyState, Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { assetTone, explorerUrl, isTestnet, leafTone, registrationTone, shortAddress } from "@/lib/rwa";

/**
 * Real-world assets, read only: what is registered, its share tokens, and the state of each
 * compressed-NFT registration. Nothing on this page signs, approves or changes anything.
 */
export default function RwaPage() {
  const t = useI18n().m.rwa;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <Overview tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

type Asset = Schemas["RwaAsset"];
type Registration = Schemas["RwaRegistration"];

/** A label from a translation map, or the raw value when the map has no entry (new values stay visible). */
const label = (map: Record<string, string>, key: string) => map[key] ?? key;

function Overview({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.rwa;
  const can = useCan();
  const allowed = can("rwa:read");
  const assets = useQuery(allowed ? `rwa-assets:${tenantId}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/rwa/assets", { params: { path: { tenantId } } })));
  const registrations = useQuery(allowed ? `rwa-registrations:${tenantId}` : null, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/rwa/registrations", { params: { path: { tenantId } } })),
  );

  if (!allowed) return <Notice tone="info">{t.noAccess}</Notice>;
  const networks = new Set([...(assets.data?.items ?? []).flatMap((a) => a.representations.map((r) => r.network)), ...(registrations.data?.items ?? []).map((r) => r.network)]);
  const testnetOnly = networks.size > 0 && [...networks].every(isTestnet);

  return (
    <>
      <Notice tone="info">{t.readOnly}</Notice>
      {testnetOnly && <Notice tone="warning">{t.testnet}</Notice>}

      <section aria-labelledby="rwa-assets">
        <h2 id="rwa-assets">{t.assetsHeading}</h2>
        {assets.loading && !assets.data && <p role="status">{t.loading}</p>}
        {assets.error && (
          <Notice tone="error" title={t.couldNotLoad}>
            {assets.error.message}
          </Notice>
        )}
        {assets.data && assets.data.items.length === 0 && <EmptyState title={t.noAssets} />}
        {assets.data && assets.data.items.length > 0 && <AssetTable items={assets.data.items} />}
      </section>

      <section aria-labelledby="rwa-registrations">
        <h2 id="rwa-registrations">{t.registrationsHeading}</h2>
        <p className="mf-muted">{t.registrationsIntro}</p>
        {registrations.loading && !registrations.data && <p role="status">{t.loading}</p>}
        {registrations.error && (
          <Notice tone="error" title={t.couldNotLoad}>
            {registrations.error.message}
          </Notice>
        )}
        {registrations.data && registrations.data.items.length === 0 && <EmptyState title={t.noRegistrations} />}
        {registrations.data && registrations.data.items.length > 0 && <RegistrationTable items={registrations.data.items} />}
      </section>
    </>
  );
}

function AssetTable({ items }: { items: Asset[] }) {
  const { m, fmt } = useI18n();
  const t = m.rwa;
  return (
    // Narrow screens scroll wide tables sideways; the region takes focus so keyboard users can scroll it too.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="table-wrap" role="region" aria-label={t.assetsHeading} tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t.col.name}</th>
            <th scope="col">{t.col.kind}</th>
            <th scope="col">{t.col.farm}</th>
            <th scope="col">{t.col.status}</th>
            <th scope="col">{t.col.tokens}</th>
            <th scope="col">{t.col.verified}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <th scope="row">{a.name}</th>
              <td>{label(t.kinds, a.kind)}</td>
              <td>{a.farmName}</td>
              <td>
                <StatusPill tone={assetTone(a.status)}>{label(t.assetStatuses, a.status)}</StatusPill>
              </td>
              <td>
                {a.representations.length === 0 ? (
                  m.common.none
                ) : (
                  <ul className="rwa-tokens">
                    {a.representations.map((r) => (
                      <li key={r.id}>
                        {label(t.rails, r.rail)} · {label(t.networks, r.network)} · {label(t.representationStatuses, r.status)}
                        {r.mintAddress && (
                          <>
                            {" · "}
                            <Address network={r.network} address={r.mintAddress} />
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td>{a.verifiedAt ? fmt.dateTime(a.verifiedAt) : t.notVerified}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegistrationTable({ items }: { items: Registration[] }) {
  const { m, fmt } = useI18n();
  const t = m.rwa;
  return (
    // Narrow screens scroll wide tables sideways; the region takes focus so keyboard users can scroll it too.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="table-wrap" role="region" aria-label={t.registrationsHeading} tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t.col.asset}</th>
            <th scope="col">{t.col.custodian}</th>
            <th scope="col">{t.col.network}</th>
            <th scope="col">{t.col.status}</th>
            <th scope="col">{t.col.leaf}</th>
            <th scope="col">{t.col.metadata}</th>
            <th scope="col">{t.col.updated}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                {r.asset.name}
                <span className="mf-muted"> · {label(t.kinds, r.asset.kind)}</span>
              </th>
              <td>
                {r.custodian.name}
                <br />
                <Address network={r.network} address={r.custodian.solanaWallet} />
              </td>
              <td>{label(t.networks, r.network)}</td>
              <td>
                <StatusPill tone={registrationTone(r.status)}>{label(t.registrationStatuses, r.status)}</StatusPill>
                {r.approvedAt && <span className="mf-muted"> {t.approvedOn(fmt.dateTime(r.approvedAt))}</span>}
              </td>
              <td>
                <StatusPill tone={leafTone(r.leaf.status)}>{label(t.leafStatuses, r.leaf.status)}</StatusPill>
                {r.leaf.leafIndex !== null && <span className="mf-muted"> {t.leafIndex(r.leaf.leafIndex)}</span>}
                {r.leaf.assetId && (
                  <>
                    <br />
                    <Address network={r.network} address={r.leaf.assetId} />
                  </>
                )}
              </td>
              <td>
                <a href={r.leaf.metadataUri} target="_blank" rel="noopener noreferrer">
                  {t.publicRecord}
                </a>
              </td>
              <td>{fmt.dateTime(r.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A shortened address, linked to the explorer of its network when that is known; the full value is in the title. */
function Address({ network, address }: { network: string; address: string }) {
  const t = useI18n().m.rwa;
  const short = shortAddress(address) ?? address;
  const href = explorerUrl(network, address);
  const text = (
    <code title={address} dir="ltr">
      {short}
    </code>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t.openInExplorer(short)}>
      {text}
    </a>
  ) : (
    text
  );
}
