# Harvest traceability

Each harvest batch gets a 10-character code (no 0/O or 1/I/L) and a QR label.
Anyone with the code can open `/verify/<code>` without signing in and check that
the batch record has not changed since it was registered.

## What is published

| Public (verify page, fingerprint) | Private (workspace only) |
| --- | --- |
| crop, parcel name, harvest date, quantity, unit, grade, farm name, workspace name, record time | who recorded it, notes, the farm's location, everything else |

On-chain there is **only** a SHA-256 fingerprint of the public record, keyed by the
batch id. No names, coordinates or personal data are written to the chain.

The fingerprint is `sha256(canonicalJson(record))`: JSON with keys sorted at every
level and no whitespace (`packages/domain/src/harvest.ts`). The verify page
recomputes it in the reader's browser, and the API reads `entryOf(batchId)` from
the registry live, so a reader does not have to trust the server's own claim.

A record can never be edited (database trigger + contract rule). Mistakes are
**voided**: the batch stays visible, marked void, and the void is registered on-chain too.

## What it proves, and what it does not

Registration proves the record has not changed since it was registered. It does
not prove the record is true, and it is not a certificate of quality, origin or
ownership. The registry is not a token: nothing can be owned, transferred or traded.

## Moving parts

- `contracts/nft/contracts/HarvestRegistry.sol`: append-only `record(batchId, hash)` and
  `voidBatch(batchId, reasonHash)`, `RECORDER_ROLE` only; admin manages roles.
- API: `POST /farms/{farmId}/harvests` stores the batch and queues `harvest-anchoring`;
  `GET /v1/public/harvests/{code}` serves the verify page.
- Worker: reads the registry first, sends at most one transaction per batch (re-awaits
  an already-sent one), and marks the batch `confirmed`, or `failed` after the last retry.
  Managers can retry from the Harvests tab.

## Turning it on (staging: a test network)

1. **Create a wallet for the app** (for example a new account in MetaMask) and copy its
   address and private key. Use it only for this. On a test network the coins are free
   and worthless; on a real network keep only a small amount of gas money on it.
2. **Fund it with test coins** from a faucet for your chosen test network
   (for example Base Sepolia, chain id 84532).
3. **Add GitHub secrets** (Settings → Secrets and variables → Actions):
   `DEPLOY_RPC_URL` (an RPC endpoint for that network) and `DEPLOYER_PRIVATE_KEY`.
4. **Run the workflow** *Deploy harvest registry* (Actions tab) with the wallet's
   address as `recorder`. Its summary shows `HARVEST_REGISTRY_ADDRESS`.
5. **Set Railway variables**
   - api and worker: `CHAIN_RPC_URL`, `CHAIN_ID`, `HARVEST_REGISTRY_ADDRESS`, `CHAIN_NAME`
     (e.g. `Base Sepolia`), `CHAIN_EXPLORER_TX_URL` (e.g. `https://sepolia.basescan.org/tx/`),
     `CHAIN_CONFIRMATIONS` (2 is plenty on a test network).
   - worker only: `CHAIN_SIGNER_PRIVATE_KEY` (sealed variable).
6. Batches recorded earlier show *Not registered*; use **Register again** on each.

For production use a separate admin key (ideally a multisig) from the recorder key,
and have the contract and key handling reviewed (`TODO(legal-review)`, `docs/threat-model.md`).
