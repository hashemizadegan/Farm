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

## API and worker

- **Permissions**: `rwa:read` (owners, admins, managers), `rwa:operate` (register investors and
  wallets, place orders, record payments; owners and admins), `compliance:review` (record KYC and
  screenings; owners and admins).
- `POST /v1/tenants/{id}/rwa/parties`, `…/{partyId}/kyc`, `…/wallets` (address checked for its
  rail), `…/screenings`; `GET` returns wallets, the screening log and the current compliance decision.
- `POST /v1/tenants/{id}/rwa/orders` runs the gate on the investor and both wallets (422
  `compliance_blocked` with reasons) and refuses mainnets unless `RWA_MAINNET_ENABLED`.
- `POST …/orders/{orderId}/payments {txId}`: the investor's subscription payment is accepted only
  if the solidified TRON chain shows exactly that TRC-20 transfer (token, investor wallet, treasury
  `RWA_TRON_TREASURY`, amount) with a successful receipt and the token's Transfer event. It is
  verified outside the database transaction, then recorded under a lock after re-running the gate.
  A payment counts for one order only (unique per network).
- The worker's reconciliation sweep (with the scheduled sweeps) opens cases, stops an order
  (`exception`) on amount mismatches, duplicates, a second leg without the first, or orphan chain
  transactions, and completes an order whose legs are done with nothing wrong.

## Share tokens and issuance

- `POST …/rwa/assets` registers an asset (draft); `…/verify` must be done by someone else
  (four eyes); parcels and trees need geometry, which must lie within the farm's current boundary.
- `POST …/assets/{id}/representations` plans a Token-2022 share token for a verified asset;
  `POST …/representations/{id}/mint` links an existing mint only after reading it from the chain:
  an initialised Token-2022 mint whose mint authority is the platform issuer (`RWA_SOLANA_ISSUER`).
- **Execution engine** (worker, every 10 s when `RWA_SOLANA_RPC_URL` and a signer are configured):
  a subscription whose payment is verified gets one mint intent (`secondLegMayStart`); each live
  intent gets one attempt; each attempt moves one step per tick: compliance re-checked at signing
  time → signed and **stored before sending** → sent → observed → final → done. Pending
  transactions are re-sent byte for byte; a new attempt is made only after the previous one
  provably expired; a simulation failure is final. Signing and RPC calls happen outside database
  transactions; each result is written under a row lock after checking the attempt has not moved.
- **Signers**: devnet uses `RWA_SOLANA_SIGNER_SECRET` (a platform secret the operator sets),
  refused whenever mainnets are enabled. Production needs a KMS/HSM signer behind the same
  `Ed25519Signer` port.

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
2. Redemptions (burn, then payout) and distributions (payout) with a second person's approval,
   TRON payouts through the engine, a KMS/HSM signer, and a `CompliancePort` adapter.
3. Retire the collectibles and Ethereum wallet sign-in; move harvest anchoring behind a port.

Keys for minting and settlement belong in a KMS/HSM set up by the operator; the app never stores them.
