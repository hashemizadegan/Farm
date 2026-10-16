# NFT contracts

Two contracts built on OpenZeppelin Contracts v5:

| Contract | Standard | Purpose |
| --- | --- | --- |
| `FarmProjectCollectible` | ERC-721 | One unique digital collectible per farm *project* in the app |
| `FarmSceneItems` | ERC-1155 | Repeated digital items (decorations, badges, cosmetic themes) for the 3D scene |

**What these tokens are not.** They do not convey land title or any interest in land, crop ownership, a share of profit or revenue, or any claim on the issuer, and they carry no promise of value. See `docs/data-provenance-and-legal.md`.

## Safety properties (enforced and tested)

- **Explicit roles**: `MINTER_ROLE`, `PAUSER_ROLE`, `ITEM_DEFINER_ROLE` (1155), `DEFAULT_ADMIN_ROLE`. The admin does not mint unless separately granted the minter role.
- **Fixed supply**: ERC-721 `maxSupply` is immutable. ERC-1155 per-id caps are set once by `defineItem` and can never be raised. Batch mints count repeated ids together.
- **Pause = emergency stop only**: halts minting and transfers; balances and ownership are untouched.
- **No confiscation**: no admin transfer, admin burn, blocklist or supply-raising function.
- **No sensitive data on-chain**: token URIs point to public metadata validated against `packages/contracts/nft-metadata.schema.json` and the content filter in `packages/domain/src/nft.ts` (no coordinates, personal data, deeds, sensor credentials or identity mappings).

## Commands

```bash
pnpm --filter @metafarm/nft-contracts compile
pnpm --filter @metafarm/nft-contracts test
pnpm --filter @metafarm/nft-contracts node          # local chain on :8545
pnpm --filter @metafarm/nft-contracts deploy:local  # prints addresses for .env
```

Before any non-local deployment: independent security review of the contracts and the key-management plan, and jurisdiction-specific legal review (`TODO(legal-review)`).
