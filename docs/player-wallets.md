# Player wallets (J8)

Status: implemented on a draft branch, with automated tests. **Off by default and not deployed.** It
has not been tried with a real browser wallet.

## Two relationships, never mixed

| | Player wallet (this document) | RWA party wallet |
| --- | --- | --- |
| Belongs to | The platform user: their player (game) identity | A compliance-screened RWA party (investor) of one workspace |
| Stored in | `player_wallets` (migration 0022), per user | `party_wallets` (migration 0012), per workspace |
| Created by | The user, in the web app, proving control with a signed message | An operator with `rwa:operate`, followed by screening |
| Used for | "You hold this" in the twin (`heldByYou`) | Orders, compliance and settlement |

Neither is ever derived from the other. Linking a player wallet creates no party wallet; registering a
party wallet makes no player wallet and no `heldByYou`. An address used in both domains gets two
explicit records, each with its own consent and validation. Owner decision, 2026-10-21.

## How linking works

1. The account page finds Solana wallets in the browser through the Wallet Standard. No wallet library
   is used.
2. The user picks a wallet. The page connects to it (`standard:connect`) to learn its address, and
   asks the API for a challenge: `POST /v1/me/player-wallets/challenge {address}`.
3. The API stores and returns a one-time message. It names the web app's domain and the address,
   states that it authorises no transaction and registers nothing with an investor account, and
   expires after `WALLET_NONCE_TTL_SECONDS`.
4. The wallet signs exactly those bytes (`solana:signMessage`). This is an off-chain Ed25519
   signature, not a transaction. The page refuses a result whose signed bytes differ from the message.
5. `POST /v1/me/player-wallets {address, signature}`. The API takes the challenge (single use: it is
   consumed whatever the outcome) and checks the signature with the address's public key, using
   Node's built-in Ed25519. It then links the wallet: 201 when new, 200 when already linked to the same
   user, 409 when the wallet is linked to another user.
6. `GET /v1/me/player-wallets` lists the user's wallets, and
   `DELETE /v1/me/player-wallets/{address}` unlinks one.

The platform holds no key and signs nothing. No transaction is built, signed or sent, and no RPC call
is made. The audit log records link, unlink and rejected attempts with the chain and the reason. The
address-to-user mapping lives only in `player_wallets`, not in the logs. The tables are not granted to
the tenant role, so workspace-scoped code cannot list players' wallets.

## "You hold this" (read-only)

`GET /v1/tenants/{id}/twin/assets/{assetId}` adds `heldByYou` to an `indexed` ownership reading when
all of these hold:
- the reading comes from the chain (`chain_index` or `das`), never from fixtures;
- `PLAYER_WALLETS_ENABLED` is on;
- the caller has linked at least one player wallet.

It is true when one of those wallets is among the holders, with a positive amount. Otherwise the field
is absent, which means "not stated" and never "no". The Unity client only reads it ("You hold this");
it never links, holds keys or signs.

## Settings (all off by default)

| Setting | Service | Effect |
| --- | --- | --- |
| `PLAYER_WALLETS_ENABLED` | api | The four routes. Off: they answer 404, and `heldByYou` is never added. |
| `NEXT_PUBLIC_PLAYER_WALLETS_ENABLED` | web | Shows the section on the account page. |
| `WALLET_AUTH_DOMAIN`, `WALLET_AUTH_URI`, `WALLET_NONCE_TTL_SECONDS` | api | The message's domain, URI and lifetime (shared with the EVM link). |

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A user links a wallet only by signing that wallet's current, unexpired, single-use challenge | `apps/api/src/player-wallets.int.test.ts`; `packages/chain/src/solana/player-wallet.test.ts` |
| 2 | A wrong, replayed, tampered or expired signature links nothing | same |
| 3 | A wallet is linked to at most one user; users unlink only their own wallets | same |
| 4 | Player and party wallets never derive from each other | int test ("keeps player wallets and RWA party wallets apart"); schema test (0022 references no party table) |
| 5 | `heldByYou` only for chain readings, only when on and linked; absence is never "no" | int test; C# `OwnershipAndSafetyTests` |
| 6 | The web page calls only `standard:connect` and `solana:signMessage`, never a transaction feature | `apps/web/src/lib/player-wallets.test.ts` |
| 7 | Off by default everywhere | int test (404 when off); config defaults |
| 8 | No platform signing, keys, transactions or RPC writes | code review: no signer and no RPC in these paths |
| 9 | Works with a real browser wallet (Phantom, Solflare, Backpack) | **Pending**: needs a manual check in a browser, then a deploy (on hold) |
| 10 | Unity shows "You hold this" in the Editor and the IL2CPP player | **Pending**: no Unity environment |
