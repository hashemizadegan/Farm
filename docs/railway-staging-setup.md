# Staging on Railway: step by step

Choices for this setup: **Auth0** for sign-in, a **Railway bucket** for uploads. Do staging first; production is the same steps in a second environment with its own Auth0 application, bucket and secrets.

## 1. Auth0 (about 10 minutes)

1. Create an Auth0 tenant (or use an existing one). Note its domain, e.g. `your-tenant.us.auth0.com`.
2. **Applications → APIs → Create API**
   - Name: `Metafarm API (staging)`
   - Identifier (this is the *audience*): `https://api.metafarm-staging` — any URI-shaped string; it is never fetched.
   - Signing algorithm: RS256.
3. **Applications → Applications → Create Application → Single Page Application**
   - Name: `Metafarm Web (staging)`
   - After you have the web service's Railway domain (step 3 below), set:
     - Allowed Callback URLs: `https://<web-domain>/auth/callback`
     - Allowed Logout URLs: `https://<web-domain>/sign-in`
     - Allowed Web Origins: `https://<web-domain>`
   - Note the **Client ID**. There is no client secret for a single-page app (PKCE is used instead).

## 2. Create the Railway project and environment

1. New project → rename the default environment to `staging` (or create `staging`).
2. Connect GitHub and grant Railway access to `hashemizadegan/Farm`.

## 3. Create the services

Create in this order. For each **GitHub** service: Source = `hashemizadegan/Farm`, branch = `main` for now (switch to a `staging` branch later if you want to gate releases), **Root directory = `/`**.

| Service name | Source | Settings |
| --- | --- | --- |
| `postgres` | Docker image `postgis/postgis:16-3.4` | Attach a **volume** at `/var/lib/postgresql/data`. Variables: `POSTGRES_USER=metafarm`, `POSTGRES_DB=metafarm`, `POSTGRES_PASSWORD=<generate a long random value>`, `PGDATA=/var/lib/postgresql/data/pgdata`. No public domain. |
| `redis` | Railway Redis template | No public domain. Confirm `maxmemory-policy` is `noeviction`. |
| `uploads` | Railway **bucket** | Keep private. Choose the region nearest your users (cannot change later). |
| `api` | GitHub | Pre-deploy command: `node dist/migrate.js`. Health check path: `/readyz`. **Generate a public domain.** |
| `worker` | GitHub | Health check path: `/healthz`. No public domain. |
| `scheduler` | GitHub | Health check path: `/healthz`. No public domain. 1 replica. |
| `web` | GitHub | Health check path: `/sign-in`. **Generate a public domain.** |

The service names matter. The build picks the app from the service name (`api`, `web`, `worker`, `scheduler`), and the variables below reference `postgres`, `redis` and `uploads` by name. If Railway shows **Railpack** in a build log instead of a Docker build, the service is not seeing the root `Dockerfile` — check that its root directory is `/`.

## 4. Variables

`${{...}}` values are Railway variable references — paste them literally.

**Shared by `api`, `worker`, `scheduler`**

```
APP_ENV=staging
LOG_LEVEL=info
HOST=::
QUEUE_PREFIX=metafarm
REDIS_URL=${{redis.REDIS_URL}}
```

**`api` and `worker` (database + storage)**

```
DATABASE_URL=postgres://metafarm:${{postgres.POSTGRES_PASSWORD}}@postgres.railway.internal:5432/metafarm
DATABASE_SSL=false
STORAGE_DRIVER=s3
S3_ENDPOINT=${{uploads.ENDPOINT}}
S3_REGION=${{uploads.REGION}}
S3_BUCKET=${{uploads.BUCKET}}
S3_ACCESS_KEY_ID=${{uploads.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{uploads.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
```

If the bucket's **Credentials** tab says it uses path-style URLs, set `S3_FORCE_PATH_STYLE=true`.

**`api` only**

```
AUTH_PROVIDER=oidc
OIDC_ISSUER_URL=https://<your-tenant>.us.auth0.com/
OIDC_AUDIENCE=https://api.metafarm-staging
CORS_ORIGINS=https://<web-domain>
WEBHOOK_SIGNING_SECRETS=<generate a long random value>
WALLET_AUTH_DOMAIN=<web-domain>
WALLET_AUTH_URI=https://<web-domain>
WALLET_ALLOWED_CHAIN_IDS=<chain id, e.g. 11155111 for Sepolia, or 31337 if unused>
AUDIT_IP_SALT=<generate a long random value>
UPLOAD_MODE=proxy
```

**`worker` only**

```
IMAGERY_PROVIDER=none
```

**`web` only** (inlined at build time — redeploy after changing)

```
NEXT_PUBLIC_API_URL=https://<api-domain>
NEXT_PUBLIC_OIDC_AUTHORITY=https://<your-tenant>.us.auth0.com
NEXT_PUBLIC_OIDC_CLIENT_ID=<SPA client id>
NEXT_PUBLIC_OIDC_AUDIENCE=https://api.metafarm-staging
NEXT_PUBLIC_WALLET_CHAIN_ID=<same chain id as the API>
# Free basemap, no key (https://openfreemap.org). Its style already carries the
# required attribution, so NEXT_PUBLIC_MAP_ATTRIBUTION stays unset.
NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
NEXT_PUBLIC_MAP_CONNECT_SRC=https://tiles.openfreemap.org
```

Generate random values locally with `openssl rand -hex 32`. Do not reuse them between staging and production.

## 5. Uploads: set `UPLOAD_MODE=proxy` on `api`

Railway buckets do not accept a CORS policy (tested on staging: the browser's preflight to the bucket gets no `Access-Control-Allow-Origin`; a Railway community thread also reports `PutBucketCors` returning 403 with the bucket's credentials). So browsers cannot PUT to a presigned bucket URL. Set **`UPLOAD_MODE=proxy`** on the `api` service: the upload URL the API returns then points at the API itself (`PUT /v1/tenants/{tenantId}/uploads/{mediaId}/content`), which checks type, size and SHA-256 and writes to the bucket.

If you later move to a bucket that supports CORS (AWS S3, Cloudflare R2), switch back to `UPLOAD_MODE=direct`, allow `PUT` from `https://<web-domain>` with the `content-type` header in the bucket's CORS policy, and add the bucket origin to the web service as `NEXT_PUBLIC_UPLOAD_CONNECT_SRC`.

## 6. First deploy and checks

1. Deploy `postgres`, `redis`, `uploads`, then `api` (its pre-deploy step runs the migrations), then `worker`, `scheduler`, `web`.
2. `https://<api-domain>/readyz` should return `{"status":"ok", ...}` with `database`, `queue` and `storage` all `ok`.
3. Open `https://<web-domain>/sign-in` → **Continue to sign in** → Auth0 → you return to `/farms`.
4. Your account has no workspace yet, so the app shows **Create your workspace**. Enter a name; you become its owner. (Set `SELF_SERVE_WORKSPACES=false` on `api` to turn this off and create workspaces yourself; `MAX_OWNED_WORKSPACES`, default 3, caps how many one person can own.)
5. Create a farm, submit a boundary, confirm it becomes **Valid** (proves the worker, Redis and PostGIS work), save a plan and open the 3D scene.
6. Upload a test evidence file to confirm the bucket and CORS.

## 7. Production

Repeat in a `production` environment with: its own Auth0 API and SPA application (or the same tenant with separate apps), its own bucket, new random secrets, `APP_ENV=production`, and replicas as in `.railway/railway.ts`. Set up the backups in `docs/deployment-railway.md` §11 before real users arrive.
