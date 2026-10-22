# Private-preview access gate

A switch that makes a deployment private, so an isolated preview (for example the simulation-only `/yield`
operator pages on development data) can run on a public platform URL without being open to the internet. **Off by
default**: deployments that do not set it are unchanged.

## Configuration (platform variables only; never commit values)

| Service | Variable | Values | Effect |
|---|---|---|---|
| api | `PREVIEW_ACCESS_GATE` | `true`/`1` on, `false`/`0` off (default `false`); anything else refuses to start | Every request except `GET /healthz`, `GET /readyz` and CORS preflights (`OPTIONS`) needs a bearer token the configured auth provider verifies, or gets the standard `401 unauthorized` before any route runs. This closes the unauthenticated endpoints too: API docs, public metadata, webhooks, unknown paths. |
| web | `PREVIEW_ACCESS_GATE` | unset/`false`/`0`/`off` off; anything else **on** (a typo cannot open the preview) | Every path, static assets included, needs HTTP Basic credentials, or gets `401` with a Basic challenge. Only `GET`/`HEAD /healthz` (the platform health check) passes without them. |
| web | `PREVIEW_ACCESS_PASSWORD` | ≥ 24 characters | The shared secret (user name `preview`). Gate on and no usable password: `503` on every path except `/healthz` (fails closed). |

Both are server-side variables (not `NEXT_PUBLIC_*`), so they never reach the browser bundle. The password is
compared by SHA-256 digest in constant time and never logged or echoed.

## How a preview session works
1. The browser asks for the preview credentials once (Basic). It then sends them on every same-origin request:
   pages, Next.js data requests and assets.
2. The web app calls the API cross-origin with the user's bearer token, as it always does. The API gate admits
   only verified tokens. With the development auth provider, tokens are minted out of band by the operator
   (`pnpm --filter @metafarm/api dev-token <subject>`, which needs `DEV_AUTH_SECRET`). The secret never reaches
   the web app; the sign-in page only accepts a pasted token.

Set the web health check path to `/healthz` on gated deployments; `/offline` would be refused.

## Environment guards this works with (unchanged)
- `APP_ENV` is one of `development`, `test`, `staging`, `production`. There is no `preview` value, and none is
  added.
- In `staging`/`production`, dev auth (`AUTH_PROVIDER=dev`) and `DEV_AUTH_SECRET` are refused, and so are:
  - `YIELD_CLAIM_INTENTS_ENABLED` and `HOLDER_YIELD_ENABLED` (refused in staging and production);
  - `YIELD_WORKFLOW_ENABLED` and `PARTY_LINKS_ENABLED` (refused in production);
  - the web build's `NEXT_PUBLIC_YIELD_PAGES_ENABLED` (refused in staging and production).
- The yield seed (`pnpm seed:yield`) runs only when `APP_ENV` is `development` or `test`.

A deployed simulation preview therefore runs with `APP_ENV=development` and dev auth. That is exactly why it
needs this gate: the gate keeps that development configuration off the public internet without weakening
any guard.

## Limits
- The gate controls who can reach the deployment. It is not user authentication: inside the preview, the
  application's own authentication and roles still apply.
- One shared secret. Rotate it by changing the variable and redeploying.
- Requires Next.js ≥ 15.2.3 (middleware authorisation bypass fix, CVE-2025-29927); this repository is on 15.5.
