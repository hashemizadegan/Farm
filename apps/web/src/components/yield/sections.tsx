"use client";
/**
 * Read-only sections of the operator cycle view (`/yield/[cycleId]`): four-eyes, the calculation dossier, carry-forward
 * and the claim-intent batch. Each loads and fails on its own, so one failure leaves the rest of the page usable.
 * Nothing here writes: actions stay in the API workflow (off by default; refused when deployed).
 */
import { Notice, StatusPill } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { fourEyes, groupDigits, shortHash, viewState } from "@/lib/yield";

type Params = { tenantId: string; cycleId: string };
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

/** Who prepared (calculate), who attested, who approved; approval by the preparer is refused by the database. */
export function FourEyesPanel({ history, attesters, status }: { history: { command: string; actorUserId: string | null }[]; attesters: number; status: string }) {
  const t = useI18n().m.yield;
  const f = fourEyes(history);
  const approvedStates = ["approved", "published", "disputed", "closed", "superseded"];
  return (
    <section aria-labelledby="yield-four-eyes" className="card" data-section="four-eyes">
      <h2 id="yield-four-eyes">{t.fourEyesHeading}</h2>
      <dl className="facts">
        <div>
          <dt>{t.preparedBy}</dt>
          <dd>{short(f.preparedBy)}</dd>
        </div>
        <div>
          <dt>{t.attestations}</dt>
          <dd>{t.attesters(attesters)}</dd>
        </div>
        <div>
          <dt>{t.approvedBy}</dt>
          <dd>{f.approvedBy ? short(f.approvedBy) : approvedStates.includes(status) ? "—" : t.awaitingApproval}</dd>
        </div>
        <div>
          <dt>{t.separation}</dt>
          <dd>
            {f.separated === null ? (
              <StatusPill tone="pending">{t.separationPending}</StatusPill>
            ) : f.separated ? (
              <StatusPill tone="ok">{t.separationOk}</StatusPill>
            ) : (
              <StatusPill tone="problem">{t.separationBroken}</StatusPill>
            )}
          </dd>
        </div>
      </dl>
      <p className="mf-muted">{t.fourEyesNote}</p>
    </section>
  );
}

type DossierView = {
  revision: number;
  sha256: string;
  assetClass: string;
  calculationPolicy: { id: string; version: number; status: string; formulaVersion: string; accountingCurrency: string; fee: string };
  distributionPolicy: { id: string; version: number; status: string; dustThreshold: string; missingPayoutWallet: string };
  settlementRate: { num: string; den: string; source: string };
  lines: { lineId: string; category: string; amount: string | null; currency: string; completeness: string }[];
  evidenceCount: number;
  payoutParties: number;
  ownershipObservedAt: string;
};

export function CalculationDossier({ tenantId, cycleId }: Params) {
  const t = useI18n().m.yield;
  const q = useQuery(`yield-dossier:${cycleId}`, async () => (await unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles/{cycleId}/simulation-dossier", { params: { path: { tenantId, cycleId } } }))) as unknown as DossierView);
  const err = q.error as (Error & { status?: number }) | undefined;
  return (
    <section aria-labelledby="yield-dossier" data-section="dossier">
      <h2 id="yield-dossier">{t.dossierHeading}</h2>
      {q.loading && !q.data && <p role="status">{t.loading}</p>}
      {err && (err.status === 404 ? <p>{t.noDossier}</p> : <Notice tone="warning">{t.partFailed}</Notice>)}
      {q.data && (
        <div className="card">
          <dl className="facts">
            <div>
              <dt>{t.revision}</dt>
              <dd>
                {q.data.revision} · <code title={q.data.sha256}>{shortHash(q.data.sha256)}</code>
              </dd>
            </div>
            <div>
              <dt>{t.calculationPolicy}</dt>
              <dd>
                {q.data.calculationPolicy.id} v{q.data.calculationPolicy.version} · {q.data.calculationPolicy.formulaVersion} · {q.data.calculationPolicy.fee} ·{" "}
                <StatusPill tone="neutral">{q.data.calculationPolicy.status}</StatusPill>
              </dd>
            </div>
            <div>
              <dt>{t.distributionPolicy}</dt>
              <dd>
                {q.data.distributionPolicy.id} · {t.dustThreshold} {groupDigits(q.data.distributionPolicy.dustThreshold)} · <StatusPill tone="neutral">{q.data.distributionPolicy.status}</StatusPill>
              </dd>
            </div>
            <div>
              <dt>{t.settlementRate}</dt>
              <dd>
                {q.data.settlementRate.num}/{q.data.settlementRate.den} ({q.data.settlementRate.source})
              </dd>
            </div>
            <div>
              <dt>{t.evidenceAndPayouts}</dt>
              <dd>{t.evidenceCounts(q.data.evidenceCount, q.data.payoutParties)}</dd>
            </div>
          </dl>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div className="table-wrap" role="region" aria-label={t.dossierHeading} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.col.line}</th>
                  <th scope="col">{t.col.category}</th>
                  <th scope="col">{t.col.amount}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.lines.map((l) => (
                  <tr key={l.lineId}>
                    <th scope="row">{l.lineId}</th>
                    <td>{l.category}</td>
                    <td>
                      {l.amount === null ? "—" : groupDigits(l.amount)} {l.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

type CarryView = { sourceSetId: string | null; ledgerIn: { carriedRemainder: string; deferred: { partyId: string; amount: string }[]; sha256: string }; ledgerOut: { carriedRemainder: string; deferred: { partyId: string; amount: string }[]; sha256: string } };

export function CarrySummary({ tenantId, cycleId, setId }: Params & { setId: string }) {
  const t = useI18n().m.yield;
  const q = useQuery(`yield-carry:${setId}`, async () => (await unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles/{cycleId}/artifact-sets/{setId}/carry", { params: { path: { tenantId, cycleId, setId } } }))) as unknown as CarryView);
  if (!q.data) return null;
  const sum = (l: CarryView["ledgerIn"]) => (BigInt(l.carriedRemainder) + l.deferred.reduce((n, d) => n + BigInt(d.amount), 0n)).toString();
  return (
    <p className="mf-muted" data-section="carry">
      {t.carryIn(q.data.sourceSetId ? short(q.data.sourceSetId) : null, groupDigits(sum(q.data.ledgerIn)))} · {t.carryOut(groupDigits(sum(q.data.ledgerOut)), q.data.ledgerOut.deferred.length)}
    </p>
  );
}

type IntentView = { leafIndex: number; partyId: string; amount: string; payoutAddress: string; leafHash: string; signed: boolean; proof: { path: string[]; pathSha256: string } };
type BatchView = { artifactSetId: string; setNumber: number; batchSha256: string; intentCount: number; batch: { createdAt: string; network: string; signed: boolean; intents: IntentView[] } };

export function ClaimIntentsPreview({ tenantId, cycleId }: Params) {
  const t = useI18n().m.yield;
  const q = useQuery(`yield-intents:${cycleId}`, async () => (await unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles/{cycleId}/claim-intents", { params: { path: { tenantId, cycleId } } }))) as unknown as BatchView);
  const err = q.error as (Error & { status?: number }) | undefined;
  const state = viewState(q, (d) => d.intentCount === 0);
  return (
    <section aria-labelledby="yield-intents" data-section="claim-intents">
      <h2 id="yield-intents">{t.intentsHeading}</h2>
      <p className="mf-muted">{t.intentsIntro}</p>
      {state === "loading" && <p role="status">{t.loading}</p>}
      {err && (err.status === 404 ? <p>{t.noIntents}</p> : <Notice tone="warning">{t.partFailed}</Notice>)}
      {q.data && (
        <>
          <p>
            {t.batchSummary(q.data.setNumber, q.data.intentCount)} · <code title={q.data.batchSha256}>{shortHash(q.data.batchSha256)}</code> · <StatusPill tone="neutral">{t.unsigned}</StatusPill>{" "}
            <StatusPill tone="neutral">{q.data.batch.network}</StatusPill>
          </p>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div className="table-wrap" role="region" aria-label={t.intentsHeading} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.col.leaf}</th>
                  <th scope="col">{t.col.party}</th>
                  <th scope="col">{t.col.amount}</th>
                  <th scope="col">{t.col.payout}</th>
                  <th scope="col">{t.col.leafHash}</th>
                  <th scope="col">{t.col.proof}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.batch.intents.map((i) => (
                  <tr key={i.leafIndex}>
                    <th scope="row">#{i.leafIndex}</th>
                    <td>{short(i.partyId)}</td>
                    <td>{groupDigits(i.amount)}</td>
                    <td title={i.payoutAddress}>
                      <code>{shortHash(i.payoutAddress, 6)}</code>
                    </td>
                    <td title={i.leafHash}>
                      <code>{shortHash(i.leafHash)}</code>
                    </td>
                    <td title={i.proof.pathSha256}>{t.proofSteps(i.proof.path.length)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
