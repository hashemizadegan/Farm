"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, Notice, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { groupDigits, shortHash, viewState, yieldPagesEnabled, yieldStatusKey, yieldTone } from "@/lib/yield";
import { CalculationDossier, CarrySummary, ClaimIntentsPreview, FourEyesPanel } from "@/components/yield/sections";

/**
 * Y10: one yield cycle, read only, for staff: status in the plan's wording (§8), artifact sets with their hashes,
 * the ownership snapshot's provenance, and the transition history. Each part loads and fails on its own, so a
 * failed history still shows the rest (partial data). The D-39 simulation banner comes from app/yield/layout.tsx.
 * Sections (components/yield/sections.tsx): four-eyes, the calculation dossier, carry-forward per set, and the
 * unsigned claim-intent batch built from stored leaves. Read-only.
 */
export default function YieldCyclePage() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const t = useI18n().m.yield;
  if (!yieldPagesEnabled()) return <Notice tone="info">{t.disabled}</Notice>;
  return (
    <>
      <p>
        <Link href="/yield">← {t.back}</Link>
      </p>
      <Notice tone="warning">{t.internalOnly}</Notice>
      <RequireTenant>{(tenantId) => <Cycle tenantId={tenantId} cycleId={cycleId} />}</RequireTenant>
    </>
  );
}

type ArtifactSet = Schemas["YieldArtifactSet"];

function Cycle({ tenantId, cycleId }: { tenantId: string; cycleId: string }) {
  const { m, fmt } = useI18n();
  const t = m.yield;
  const can = useCan();
  const allowed = can("yield:read");
  const cycle = useQuery(allowed ? `yield-cycle:${cycleId}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles/{cycleId}", { params: { path: { tenantId, cycleId } } })));
  const history = useQuery(allowed ? `yield-cycle-history:${cycleId}` : null, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles/{cycleId}/transitions", { params: { path: { tenantId, cycleId } } })),
  );
  if (!allowed) return <Notice tone="info">{t.noAccess}</Notice>;
  const state = viewState(cycle, () => false);
  if (state === "loading") return <p role="status">{t.loading}</p>;
  if (state === "error") {
    const err = cycle.error as Error & { status?: number };
    return (
      <Notice tone="error" title={t.couldNotLoad}>
        {err.status === 404 ? t.notFound : err.message} <button type="button" onClick={cycle.reload}>{t.retry}</button>
      </Notice>
    );
  }
  const c = cycle.data!;
  const historyState = viewState(history, (d) => d.items.length === 0);

  return (
    <>
      <h1>
        {t.detailsHeading}: {c.period.start} – {c.period.end} · v{c.version}
      </h1>
      {state === "stale" && (
        <Notice tone="warning">
          {t.stale} <button type="button" onClick={cycle.reload}>{t.retry}</button>
        </Notice>
      )}
      {c.simulation && <Notice tone="info">{t.simulationNote}</Notice>}
      <Notice tone="info">{t.readOnly}</Notice>
      <div className="card">
        <dl className="facts">
          <div>
            <dt>{t.col.status}</dt>
            <dd>
              <StatusPill tone={yieldTone(c.status)}>{t.statuses[yieldStatusKey(c.status, c.closeReason)] ?? c.status}</StatusPill>
            </dd>
          </div>
          <div>
            <dt>{t.col.asset}</dt>
            <dd title={c.chainAsset.id}>
              {c.chainAsset.network} · {c.chainAsset.rail} · {c.chainAsset.id}
            </dd>
          </div>
          <div>
            <dt>{t.col.slots}</dt>
            <dd>{c.slotRange ? `(${c.slotRange.start}, ${c.slotRange.end}]` : m.common.notSet}</dd>
          </div>
          <div>
            <dt>{t.col.updated}</dt>
            <dd>{fmt.dateTime(c.updatedAt)}</dd>
          </div>
        </dl>
      </div>

      <FourEyesPanel history={history.data?.items ?? []} attesters={c.artifactSets.find((x) => x.hashes?.set === c.artifactSetHash)?.attesters ?? 0} status={c.status} />

      <CalculationDossier tenantId={tenantId} cycleId={cycleId} />

      <section aria-labelledby="yield-sets">
        <h2 id="yield-sets">{t.setsHeading}</h2>
        {c.artifactSets.length === 0 ? (
          <EmptyState title={t.noSets} />
        ) : (
          c.artifactSets.map((s) => (
            <div key={s.id}>
              <SetCard set={s} />
              <CarrySummary tenantId={tenantId} cycleId={cycleId} setId={s.id} />
            </div>
          ))
        )}
      </section>

      {(c.status === "published" || c.status === "disputed" || c.status === "closed") && <ClaimIntentsPreview tenantId={tenantId} cycleId={cycleId} />}

      <section aria-labelledby="yield-history">
        <h2 id="yield-history">{t.historyHeading}</h2>
        {historyState === "loading" && <p role="status">{t.loading}</p>}
        {historyState === "error" && <Notice tone="warning">{t.historyFailed}</Notice>}
        {historyState === "stale" && <Notice tone="warning">{t.stale}</Notice>}
        {historyState === "empty" && <p>{t.noHistory}</p>}
        {history.data && history.data.items.length > 0 && (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <div className="table-wrap" role="region" aria-label={t.historyHeading} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.col.when}</th>
                  <th scope="col">{t.col.command}</th>
                  <th scope="col">{t.col.status}</th>
                  <th scope="col">{t.col.actor}</th>
                  <th scope="col">{t.col.reason}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((h, i) => (
                  <tr key={i}>
                    <td>{fmt.dateTime(h.at)}</td>
                    <th scope="row">{h.command}</th>
                    <td>{t.statuses[h.to] ?? h.to}</td>
                    <td>{h.actorUserId ? h.actorUserId.slice(0, 8) : m.common.none}</td>
                    <td>{h.reason ?? m.common.none}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function SetCard({ set: s }: { set: ArtifactSet }) {
  const { m } = useI18n();
  const t = m.yield;
  const snap = s.ownershipSnapshot;
  return (
    <div className="card">
      <h3>
        {t.col.set} #{s.setNumber} · <StatusPill tone={s.status === "invalidated" || s.status === "superseded" ? "neutral" : "ok"}>{t.setStatuses[s.status] ?? s.status}</StatusPill>
      </h3>
      <dl className="facts">
        {Object.entries(s.hashes ?? {}).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd title={v}>
              <code>{shortHash(v)}</code>
            </dd>
          </div>
        ))}
        <div>
          <dt>{t.attesters(s.attesters)}</dt>
          <dd>{s.status === "approved" ? "" : t.verificationUnavailable}</dd>
        </div>
      </dl>
      <h4>{t.ownershipHeading}</h4>
      {!snap ? (
        <p>{t.noSnapshot}</p>
      ) : (
        <dl className="facts">
          <div>
            <dt>{t.col.source}</dt>
            <dd>{snap.sourceKind === "fixture" ? t.fixtureSource : t.rpcSource}</dd>
          </div>
          <div>
            <dt>{t.col.cursor}</dt>
            <dd>{snap.cursorSlot}</dd>
          </div>
          <div>
            <dt>{t.col.weight}</dt>
            <dd>{groupDigits(snap.totalWeight ?? "")}</dd>
          </div>
          <div>
            <dt>{t.col.commitment}</dt>
            <dd title={snap.inputCommitment}>
              <code>{shortHash(snap.inputCommitment)}</code>
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
