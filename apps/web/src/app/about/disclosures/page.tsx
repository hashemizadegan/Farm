import type { Metadata } from "next";
import { NFT_DISCLOSURE } from "@metafarm/domain/nft";
import { PROVENANCE_DESCRIPTIONS, PROVENANCE_LABELS } from "@metafarm/domain/provenance";
import { SCENARIO_DISCLAIMER } from "@metafarm/domain/scenarios";

export const metadata: Metadata = { title: "Disclosures" };

/**
 * User-facing summary of docs/data-provenance-and-legal.md.
 * TODO(legal-review): have counsel in each jurisdiction you operate in review this text.
 */
export default function DisclosuresPage() {
  return (
    <>
      <h1>Disclosures</h1>

      <h2>Land boundaries and coordinates</h2>
      <p>
        Coordinates and boundaries are submitted by users. Unless a boundary is marked <strong>Independently verified</strong> — which requires
        attached evidence reviewed by a verifier — it has not been checked against any land registry, cadastre or survey. Areas are geodesic
        estimates computed from the submitted shape.
      </p>

      <h2>3D scenes</h2>
      <p>
        The 3D scene is an illustration generated from your plan. Plant positions, sizes, equipment and terrain are not a survey, an inventory,
        or evidence of real-world conditions.
      </p>

      <h2>Crop and income scenarios</h2>
      <p>{SCENARIO_DISCLAIMER}</p>

      <h2>Digital collectibles (NFTs)</h2>
      <p>{NFT_DISCLOSURE}</p>
      <p>
        In particular, a collectible does not convey land title, crop ownership or a profit share, and nothing in this application promises that
        a token will have or keep any value.
      </p>

      <h2>Provenance labels</h2>
      <dl>
        {PROVENANCE_LABELS.map((l) => (
          <div key={l}>
            <dt>{PROVENANCE_DESCRIPTIONS[l].short}</dt>
            <dd>{PROVENANCE_DESCRIPTIONS[l].long}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
