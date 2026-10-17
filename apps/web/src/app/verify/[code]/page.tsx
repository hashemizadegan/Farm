"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { canonicalJson, harvestRecordHash } from "@metafarm/domain";
import { Notice } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { VerifyFrame } from "../VerifyFrame";

export default function VerifyBatchPage() {
  const { code } = useParams<{ code: string }>();
  const { m, fmt } = useI18n();
  const t = m.verify;
  const valid = /^[2-9A-HJKMNP-Z]{10}$/.test(code ?? "");
  const q = useQuery(valid ? `public-harvest:${code}` : null, () => unwrap(api.GET("/v1/public/harvests/{code}", { params: { path: { code } } })));
  const [hashOk, setHashOk] = useState<boolean>();

  // Recompute the fingerprint here, in the reader's own browser, rather than trusting the server's.
  useEffect(() => {
    if (!q.data) return;
    let cancelled = false;
    void harvestRecordHash(q.data.record).then((h) => !cancelled && setHashOk(h === q.data!.recordHash));
    return () => {
      cancelled = true;
    };
  }, [q.data]);

  if (!valid || q.error?.status === 404) {
    return (
      <VerifyFrame>
        <h1>{t.title}</h1>
        <Notice tone="error">{t.notFound}</Notice>
        <p>
          <Link href="/verify">{t.lookupHeading}</Link>
        </p>
      </VerifyFrame>
    );
  }
  if (q.error) {
    return (
      <VerifyFrame>
        <h1>{t.title}</h1>
        <Notice tone="error">{t.failed}</Notice>
      </VerifyFrame>
    );
  }
  if (!q.data) {
    return (
      <VerifyFrame>
        <h1>{t.title}</h1>
        <p role="status">{t.loading}</p>
      </VerifyFrame>
    );
  }

  const d = q.data;
  const r = d.record;
  const chain = d.anchor.chainName ?? t.aChain;
  const anchoredDay = d.chainCheck?.registeredAt ?? d.anchor.anchoredAt;
  let chainNotice: { tone: "info" | "warning" | "error"; text: string } | null;
  if (d.anchor.status === "confirmed") {
    if (d.chainCheck && !d.chainCheck.matches) chainNotice = { tone: "error", text: t.chainMismatch };
    else if (d.chainCheck) chainNotice = { tone: "info", text: t.chainOk(chain, anchoredDay ? fmt.dateTime(anchoredDay) : "") };
    else chainNotice = { tone: "info", text: t.chainUnchecked(chain) };
  } else if (d.anchor.status === "pending" || d.anchor.status === "submitted") chainNotice = { tone: "info", text: t.chainPending };
  else if (d.anchor.status === "failed") chainNotice = { tone: "warning", text: t.chainFailed };
  else chainNotice = { tone: "warning", text: t.chainNotConfigured };

  const ok = hashOk !== false && !(d.chainCheck && !d.chainCheck.matches) && !d.voidedAt;

  return (
    <VerifyFrame>
      <p className="verify__code">
        <span className="ltr">{d.code}</span>
      </p>
      <h1>
        {r.crop} · {r.farm}
      </h1>
      {d.voidedAt && (
        <Notice tone="error" title={m.harvests.voided}>
          {t.voided(fmt.day(d.voidedAt.slice(0, 10)))}
        </Notice>
      )}
      <dl className="facts card">
        <dt>{t.producer}</dt>
        <dd>{r.producer}</dd>
        <dt>{t.farm}</dt>
        <dd>{r.farm}</dd>
        <dt>{t.crop}</dt>
        <dd>{r.crop}</dd>
        {r.parcel && (
          <>
            <dt>{t.parcel}</dt>
            <dd>{r.parcel}</dd>
          </>
        )}
        <dt>{t.harvestedOn}</dt>
        <dd>{fmt.day(r.harvestedOn)}</dd>
        <dt>{t.quantity}</dt>
        <dd>
          {fmt.number(Number(r.quantity), { maximumFractionDigits: 3 })} {r.unit}
        </dd>
        {r.grade && (
          <>
            <dt>{t.grade}</dt>
            <dd>{r.grade}</dd>
          </>
        )}
        <dt>{t.recordedAt}</dt>
        <dd>{fmt.dateTime(r.recordedAt)}</dd>
      </dl>

      <section aria-labelledby="integrity-heading" className="verify__integrity" data-ok={ok || undefined}>
        <h2 id="integrity-heading">{t.integrityHeading}</h2>
        <ul className="verify__checks">
          {hashOk !== undefined && <li data-ok={hashOk || undefined}>{hashOk ? t.hashOk : t.hashBad}</li>}
          {chainNotice && <li data-tone={chainNotice.tone}>{chainNotice.text}</li>}
        </ul>
        {d.anchor.explorerUrl && (
          <p>
            <a href={d.anchor.explorerUrl} target="_blank" rel="noopener noreferrer">
              {t.viewTx}
            </a>
          </p>
        )}
      </section>

      <details className="card verify__tech">
        <summary>{t.technical}</summary>
        <dl className="facts">
          <dt>{t.fingerprint}</dt>
          <dd>
            <code className="verify__mono">{d.recordHash}</code>
          </dd>
          <dt>{t.batchId}</dt>
          <dd>
            <code className="verify__mono">{d.chainBatchId}</code>
          </dd>
          {d.anchor.contract && (
            <>
              <dt>{t.contract}</dt>
              <dd>
                <code className="verify__mono">{d.anchor.contract}</code>
              </dd>
            </>
          )}
          {d.anchor.chainId && (
            <>
              <dt>{t.chainId}</dt>
              <dd className="ltr">{d.anchor.chainId}</dd>
            </>
          )}
          {d.anchor.txHash && (
            <>
              <dt>{t.tx}</dt>
              <dd>
                <code className="verify__mono">{d.anchor.txHash}</code>
              </dd>
            </>
          )}
          {d.anchor.block && (
            <>
              <dt>{t.block}</dt>
              <dd className="ltr">{d.anchor.block}</dd>
            </>
          )}
        </dl>
        <p className="mf-hint">{t.howTo}</p>
        <p>
          <strong>{t.recordJson}</strong>
        </p>
        <pre className="verify__json ltr">{canonicalJson(r)}</pre>
      </details>

      <p className="mf-hint verify__disclaimer">{t.disclaimer}</p>
    </VerifyFrame>
  );
}
