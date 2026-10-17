import type { Metadata } from "next";
import { PROVENANCE_LABELS } from "@metafarm/domain/provenance";
import { en } from "@/i18n/messages/en";
import { fa } from "@/i18n/messages/fa";
import { getLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: ((await getLocale()) === "fa" ? fa : en).meta.disclosures };
}

/**
 * User-facing summary of docs/data-provenance-and-legal.md.
 * TODO(legal-review): have counsel in each jurisdiction you operate in review this text, including the Persian translation.
 */
export default async function DisclosuresPage() {
  const m = (await getLocale()) === "fa" ? fa : en;
  const t = m.disclosures;
  return (
    <>
      <h1>{t.title}</h1>
      {t.authoritative && <p className="mf-notice">{t.authoritative}</p>}

      <h2>{t.landHeading}</h2>
      <p>{t.land((x) => <strong>{x}</strong>)}</p>

      <h2>{t.sceneHeading}</h2>
      <p>{t.scene}</p>

      <h2>{t.scenarioHeading}</h2>
      <p>{t.scenario}</p>

      <h2>{t.nftHeading}</h2>
      <p>{t.nft}</p>
      <p>{t.nftExtra}</p>

      <h2>{t.provenanceHeading}</h2>
      <dl>
        {PROVENANCE_LABELS.map((l) => (
          <div key={l}>
            <dt>{m.ui.provenance[l].short}</dt>
            <dd>{m.ui.provenance[l].long}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
