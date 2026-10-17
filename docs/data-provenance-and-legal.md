# Data provenance and legal disclosures

> **TODO(legal-review):** This document describes how the software behaves. It is not legal advice. Before launch, have qualified counsel in every jurisdiction where you operate review this text, the in-app disclosures (`apps/web/src/app/about/disclosures/page.tsx`), the NFT metadata disclosure string (`packages/domain/src/nft.ts`), and your terms of service — including whether any feature could be characterised as a security, investment contract or regulated product where you operate.

## 1. What the NFTs are — and are not

The optional tokens (`contracts/nft`) are **digital collectibles or in-app utility items** (for example, a commemorative project collectible or a decoration shown in the 3D scene).

An NFT issued by this application:

- **does not convey land title** or any ownership of, lease of, or other interest in land;
- **does not convey crop ownership** or any right to harvests, produce or farm output;
- **does not convey a profit share**, revenue share, dividend, yield or any payment right;
- **does not guarantee token value**; it may have no value, and nothing in the application promises appreciation or liquidity;
- does not represent a claim against the operator or any farm.

The codebase enforces this:

- Every metadata document must contain the fixed `disclosure` string, and is validated against `packages/contracts/nft-metadata.schema.json`.
- A content filter rejects names, descriptions and attributes containing ownership, title, deed, profit, yield, investment, guarantee or appreciation language (`checkNftMetadataContent`).
- There is no fungible token, no yield mechanism, no revenue distribution and no investment product anywhere in the repository.
- The harvest registry (`HarvestRegistry.sol`, see `docs/harvest-traceability.md`) is not a token: it stores only fingerprints of public harvest records so buyers can check they were not changed. It conveys no ownership, value or right.
- Contracts have fixed supply, explicit mint roles, emergency-only pause and no confiscation.

## 2. Coordinates and boundaries may be user-submitted and unverified

- Coordinates, drawn boundaries and imported GeoJSON are stored with the provenance label **`user-entered`**.
- The application performs **geometric** validation only (valid shapes, reasonable size, no self-intersection). It does **not** check land registries, cadastres, surveys or ownership.
- A boundary becomes **`independently-verified`** only when a user with the `verifier` role attaches an uploaded evidence document. The database rejects that label without evidence. "Verified" means *a reviewer checked the attached evidence*; its scope is whatever that evidence covers.
- Areas are geodesic estimates computed from the submitted shape and are labelled as such.
- Overlaps with other boundaries are shown as information only; they are not adjudicated.

## 3. 3D scenes are not surveys or evidence

The 3D scene is generated from the user's plan with a seeded random layout. Plant positions, sizes, equipment and ground are **illustrative**. The scene is not a survey, an inventory, a photograph, or evidence of real-world conditions, and every scene element carries the `illustrative` label. The same disclaimer is shown on the scene page and returned by the API (`SceneDescription.disclaimer`).

## 4. Simulated income is not realised income

Crop scenarios compute low/base/high cases **only from figures the user enters** (yield, price, costs). The application ships no agronomic, market or financial data. Every result is stored with `kind = simulated`, labelled "Simulated" in the UI, and carries a disclaimer. Scenarios are not forecasts, not realised income, and not an offer or promise of any return.

## 5. No fabricated data

The repository contains no invented satellite imagery, weather, IoT readings, legal records, ownership records or financial figures:

- The imagery provider defaults to `none` and ingests nothing.
- Observations come only from users, registered sensors or configured providers, each labelled accordingly.
- Test fixtures use obviously synthetic coordinates and are marked as such.
- The seed script creates a demo tenant and procedural placeholder assets only.

## 6. Provenance labels

| Label | Meaning | Who/what sets it |
| --- | --- | --- |
| `illustrative` | Generated for display; not real-world data | Scene builder, asset catalogue |
| `user-entered` | Typed, drawn or uploaded by a user; not independently checked | API for user submissions |
| `provider-observation` | From an external data provider integration | Webhook/provider ingestion |
| `sensor-reported` | From a registered sensor | Webhook/sensor ingestion |
| `independently-verified` | A verifier attached evidence | Verifier action; enforced by DB trigger |

On-chain metadata may not use `independently-verified` (schema and content filter both refuse it), because a public permanent record should not imply a verification whose scope cannot be inspected there.

## 7. What never goes on-chain

Precise coordinates, boundaries, personal data (names, emails, phone numbers), deeds or registry references, sensor IDs or credentials, and wallet-to-identity mappings. The metadata schema forbids attribute names for these, and the content filter rejects coordinate-like and email-like strings.

## 8. Personal data

- Stored: OIDC subject and issuer, optional email (only if the IdP marks it verified) and display name, tenant memberships, consent records, wallet links.
- Audit records store a salted hash of the IP address, not the address.
- Logs redact authorization headers, cookies, tokens, signatures and emails.
- `TODO(legal-review)`: retention periods, data-subject request handling and cross-border transfer terms depend on your jurisdictions and providers.
