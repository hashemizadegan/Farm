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

The service names matter: the variables below reference them (`postgres`, `redis`, `uploads`).

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
RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile
AUTH_PROVIDER=oidc
OIDC_ISSUER_URL=https://<your-tenant>.us.auth0.com/
OIDC_AUDIENCE=https://api.metafarm-staging
CORS_ORIGINS=https://<web-domain>
WEBHOOK_SIGNING_SECRETS=<generate a long random value>
WALLET_AUTH_DOMAIN=<web-domain>
WALLET_AUTH_URI=https://<web-domain>
WALLET_ALLOWED_CHAIN_IDS=<chain id, e.g. 11155111 for Sepolia, or 31337 if unused>
AUDIT_IP_SALT=<generate a long random value>
```

**`worker` only**

```
RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile
IMAGERY_PROVIDER=none
```

**`scheduler` only**

```
RAILWAY_DOCKERFILE_PATH=apps/scheduler/Dockerfile
```

**`web` only** (inlined at build time — redeploy after changing)

```
RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile
NEXT_PUBLIC_API_URL=https://<api-domain>
NEXT_PUBLIC_OIDC_AUTHORITY=https://<your-tenant>.us.auth0.com
NEXT_PUBLIC_OIDC_CLIENT_ID=<SPA client id>
NEXT_PUBLIC_OIDC_AUDIENCE=https://api.metafarm-staging
NEXT_PUBLIC_WALLET_CHAIN_ID=<same chain id as the API>
```

Generate random values locally with `openssl rand -hex 32`. Do not reuse them between staging and production.

## 5. Bucket CORS (needed for browser uploads)

Uploads go straight from the browser to the bucket with a presigned **PUT**. The bucket must allow `PUT` from `https://<web-domain>` with the `content-type` header. Railway's documentation does not yet describe bucket CORS settings, so check the bucket's settings in the dashboard. If browser uploads fail with a CORS error and the bucket offers no CORS setting, the fallback is an external S3-compatible bucket that does (for example Cloudflare R2); only the `S3_*` variables change.

## 6. First deploy and checks

1. Deploy `postgres`, `redis`, `uploads`, then `api` (its pre-deploy step runs the migrations), then `worker`, `scheduler`, `web`.
2. `https://<api-domain>/readyz` should return `{"status":"ok", ...}` with `database`, `queue` and `storage` all `ok`.
3. Open `https://<web-domain>/sign-in` → **Continue to sign in** → Auth0 → you return to `/farms`.
4. Your account has no workspace yet. Create one (until a sign-up flow exists) by running against the staging database, replacing the subject with your Auth0 user id (shown in Auth0 → User Management → Users, e.g. `auth0|abc123`) after you have signed in once:

   ```sql
   WITH t AS (INSERT INTO tenants (slug, name) VALUES ('my-org', 'My Organisation') RETURNING id)
   INSERT INTO memberships (tenant_id, user_id, role)
   SELECT t.id, u.id, 'owner' FROM t, users u
    WHERE u.oidc_issuer = 'https://<your-tenant>.us.auth0.com' AND u.oidc_subject = 'auth0|abc123';
   ```

   Use Railway's database connect panel or `railway connect postgres`.
5. Create a farm, submit a boundary, confirm it becomes **Valid** (proves the worker, Redis and PostGIS work), save a plan and open the 3D scene.
6. Upload a test evidence file to confirm the bucket and CORS.

## 7. Production

Repeat in a `production` environment with: its own Auth0 API and SPA application (or the same tenant with separate apps), its own bucket, new random secrets, `APP_ENV=production`, and replicas as in `.railway/railway.ts`. Set up the backups in `docs/deployment-railway.md` §11 before real users arrive.
