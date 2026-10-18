# Real-world asset rails

Status: schema, domain model and ports; Solana Token-2022 issuance, TRON TRC-20 settlement and
observation adapters for both rails, and compressed-NFT tree planning and DAS reads (`packages/chain`),
tested against simulated nodes. Not wired into the API or worker yet; nothing issued.

## Decisions (October 2026)

| Question | Decision |
|---|---|
| Framework | Keep Fastify 5 + BullMQ and plain SQL migrations with row-level security. Ports are plain TypeScript interfaces; adapters are injected like the existing `deps`. No NestJS or Drizzle. |
| Existing EVM code | Retire the ERC-721/1155 collectibles and Ethereum wallet sign-in. Keep harvest traceability, moved behind a port (Solana adapter later). |
| Networks | Solana devnet and TRON Nile/Shasta only. Mainnets are blocked in the domain (`networkAllowed`) until legal and compliance sign-off sets `RWA_MAINNET_ENABLED`, and every intent passes the KYC/sanctions gate. |

## Model

- **`business_assets`**: the canonical registry. Each asset belongs to a farm and, for parcels and
  trees, has its own surveyed/GNSS geometry (PostGIS) once verified, optionally inside a verified
  `boundary_versions` row. The 3D scene's `plant_instances` are illustrative and are not assets.
- **`asset_representations`**: an asset on one rail and network: `SOLANA_TOKEN_2022` (mint),
  `SOLANA_BUBBLEGUM_CNFT` (tree + leaf, DAS id) or `TRON_TRC20` (contract). The database refuses a
  rail on the wrong network.
- **`issuance_intents`** (Solana side: mint, burn, freeze, thaw) and **`settlement_intents`**
  (TRON side: subscription, distribution, redemption, fee, refund) are independent. They share a
  `reconciliation_id`; there is no cross-chain atomicity. Each has an idempotency key, and nobody
  approves their own request.
- **`chain_operations`**: one attempt to land one transaction for an intent.
- **`reconciliation_cases`**: discrepancies between the rails, one open case per discrepancy.
- **`iot_telemetry`**: sensor readings keyed by sensor, metric and time (duplicates dropped), with
  the broker message id and a SHA-256 of the raw payload. A TimescaleDB hypertable where the
  extension is preloaded; a plain table on PostGIS-only databases (CI, local).

Financial tables block deleting their workspace: those records must be retained.

## Parties, compliance and orders (migration `0012_rwa_orders`)

- **`parties`** are investors (people or organisations) with a jurisdiction and a KYC status taken
  from the KYC provider's case (verified needs the provider reference; documents stay with the
  provider). **`party_wallets`** ties each address to one party.
- **`compliance_screenings`** is the append-only log of sanctions screenings of parties and wallets,
  each with the provider and its reference. There are no built-in lists.
- **The gate** (`complianceDecision`) allows an order only with verified, unexpired KYC, a known
  jurisdiction that the operator has not excluded, and a clear screening of the party and of every
  wallet involved, each younger than the policy's maximum age. Anything missing, stale, under review
  or blocked stops it, with reasons.
- **`rwa_orders`** say what should happen: a subscription is paid on TRON and then issued on Solana;
  a redemption is burned on Solana and then paid out on TRON; a distribution is paid out only. Every
  intent and reconciliation case now belongs to an order (foreign key on `reconciliation_id`).
- **Sequencing** (`secondLegMayStart`): the second leg starts only after the first completed exactly
  once for exactly the ordered amount, and never while another second leg is under way.
- **Reconciliation** (`reconcileOrder`) reports duplicates, amount mismatches (observed on chain
  when known), a second leg that ran without the first (always), a second leg overdue past the SLA,
  chain transactions confirmed for abandoned intents, and orders that sat idle. Each becomes at most
  one open `reconciliation_cases` row per kind.

## Operation lifecycle

```
requested → policy_approved → prepared → submitted → observed → confirmed → business_completed
    └→ policy_rejected      └→ failed   └→ expired/failed └→ expired/failed
```

- `confirmed` = final on that rail: Solana `finalized`, TRON solidified (19+ SR confirmations).
- `expired` = provably never landed (Solana: block height passed `last_valid_block_height`, signature
  unknown; TRON: past `expiration`, transaction unknown). Only then may a new attempt be made.
- An attempt that is `submitted` or `observed` has an unknown outcome and is never resent.
- The database enforces the transitions (trigger), logs each one in the append-only
  `chain_operation_transitions`, never deletes operations, fixes their identity and transaction
  reference, and allows one live attempt per intent.

## Adapters (`packages/chain`)

- **No Solana SDK at runtime.** `@solana/web3.js` 1.x and `@solana/spl-token` pull in `bigint-buffer`,
  which has an unpatched high-severity advisory (GHSA-3gc7-fjrx-p6mg), so production code builds and
  signs transactions with a small codec on the audited `@noble/curves` and `@noble/hashes`. The SDKs
  are dev-only dependencies: tests check our addresses, program-derived addresses, instruction bytes,
  mint sizes and whole signed transactions against them.
- **Signing** goes through the `Ed25519Signer` port (a KMS/HSM in production). A new mint's own key
  is generated in memory, signs the creation once and is discarded.
- **Token-2022**: mints with optional transfer fee, permanent delegate (redemption, court-ordered
  recovery) and transfer hook (e.g. an allow-list program); mint (creating the holder's associated
  token account idempotently), burn, freeze, thaw. Amounts are checked against u64.
- **Fees and validity**: compute-unit limit, priority fee at the 75th percentile of recent non-zero
  fees on the touched accounts (capped), recent blockhash with its last valid block height.
- **Observation**: sends with `maxRetries: 0` and re-sends the same signed bytes (never a new
  transaction) while pending; reads `getSignatureStatuses` with history; declares `expired` only when
  the finalized block height is past the last valid height and a second lookup still finds nothing.
  A failed simulation is a definitive failure; network errors are not.
- **TRON (no TronWeb at runtime, same reason)**: the full node builds the unsigned TRC-20
  transfer, so before signing the adapter decodes its protobuf and refuses it unless the sender,
  token contract, recipient and amount (ABI call data), zero TRX/TRC-10 value, fee limit and a sane
  expiration (under 24 h) are exactly as requested and the transaction id is the SHA-256 of its raw
  data. Before that: the sender's token balance is checked, the transfer is simulated
  (`triggerconstantcontract`) for success and energy, and the fee limit is energy × the chain's
  current energy price × 1.2, refused above a cap. After signing, the signature is recovered and
  must be the sender's. Bandwidth is estimated from the signed size.
- **TRON finality**: final only when the solidity node returns the transaction (block confirmed by
  19 of 27 super representatives); failed when its receipt is not `SUCCESS`; `expired` only once
  the solidified head is past the expiration and a second lookup finds nothing. Duplicate
  broadcasts are success; signature, validation, expiration and TaPoS refusals are definitive.
- **Compressed NFTs (Bubblegum)**: `planTree` picks the smallest valid depth/buffer shape for the
  number of assets and concurrency, with a canopy that keeps each transfer at no more than 8 proof
  accounts, and sizes the account (checked against published reference sizes). The DAS
  adapter hands out a proof only after it hashes (keccak256) to the reported root **and** that root
  is still in the on-chain tree's change-log buffer; otherwise it asks again, then fails with
  `StaleProofError`. Proofs are never cached across writes; `isStaleProofError` recognises a
  transaction that ran with an out-of-date proof so a new attempt fetches a fresh one.
  Minting instructions (Bubblegum `mintV1`) come next, once the Metaplex packages pass the audit.
- `stepsAfterObservation` (domain) turns what a chain reports into lifecycle steps.

## Next

1. Bubblegum minting and transfers (tree creation, `mintV1`).
2. A `CompliancePort` adapter for the chosen KYC/sanctions provider, and the order workflow in the
   API and worker (gate → first leg → second leg → reconciliation sweep).
3. Retire the collectibles and Ethereum wallet sign-in; move harvest anchoring behind a port.

Keys for minting and settlement belong in a KMS/HSM set up by the operator; the app never stores them.
