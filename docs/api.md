# API

- Contract: [`packages/contracts/openapi.yaml`](../packages/contracts/openapi.yaml) (OpenAPI 3.1). Typed client types are generated from it into `packages/contracts/src/generated/api.ts` on install (`pnpm contracts:openapi`).
- Interactive docs: `http://localhost:4000/docs` (disabled when `APP_ENV=production`).
- All tenant routes: `/v1/tenants/{tenantId}/…`. Other tenants' resources return `404`.
- Errors: `{ "error": "<code>", "message": "…", "requestId": "…", "details"?: … }`.

## Setup for the examples

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm dev                                   # api on :4000, web on :3000, worker, scheduler

export API=http://localhost:4000
export TOKEN=$(pnpm --silent --filter @metafarm/api dev-token dev-user)
export TENANT=$(curl -s $API/v1/me -H "authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).tenants[0].tenantId')
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")
```

## Health

```bash
curl -s $API/healthz        # {"status":"ok"}
curl -s $API/readyz         # {"status":"ok","checks":{"database":"ok","queue":"ok","storage":"ok"}}
```

## Farms

```bash
# Create a farm with an origin point (stored as user-entered)
FARM=$(curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms \
  -d '{"name":"North field","origin":{"lon":10.0,"lat":45.0}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s "${H[@]}" "$API/v1/tenants/$TENANT/farms?limit=10"
curl -s "${H[@]}" $API/v1/tenants/$TENANT/farms/$FARM
```

## Boundaries

```bash
# Submit (202: queued for PostGIS validation; 422: rejected with issues; 409: duplicate)
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/boundaries -d '{
  "source": "drawn",
  "geojson": {"type":"Polygon","coordinates":[[[9.999,44.999],[10.001,44.999],[10.001,45.001],[9.999,45.001],[9.999,44.999]]]}
}'

# A self-intersecting shape is rejected before touching the database
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/boundaries -d '{
  "source": "drawn",
  "geojson": {"type":"Polygon","coordinates":[[[0,0],[0.001,0.001],[0.001,0],[0,0.001],[0,0]]]}
}'
# → 422 {"error":"geometry_rejected","details":[{"code":"SELF_INTERSECTION",...}]}

# Validation status
curl -s "${H[@]}" $API/v1/tenants/$TENANT/farms/$FARM/boundaries
```

## Plan, scenarios, scene, assets

```bash
curl -s "${H[@]}" -X PUT $API/v1/tenants/$TENANT/farms/$FARM/plan -d '{
  "name": "Spring plan",
  "parcels": [{"label":"A","cropName":"Example crop","grid":{"rows":10,"cols":20,"spacingM":1.5}}]
}'

# Simulated scenario from YOUR figures (the API supplies no yields/prices)
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/scenarios -d '{
  "cropName": "Example crop", "plantedAreaHa": 2,
  "yieldPerHa": {"low": 1, "base": 2, "high": 3}, "yieldUnit": "t",
  "pricePerUnit": {"low": 100, "base": 150, "high": 200},
  "costs": {"low": 50, "base": 100, "high": 150}, "currency": "USD"
}'
# → "kind":"simulated", with a disclaimer

curl -s "${H[@]}" $API/v1/tenants/$TENANT/farms/$FARM/scene     # deterministic, illustrative
curl -s "${H[@]}" "$API/v1/tenants/$TENANT/assets?kind=plant"
```

## Observations and alerts

```bash
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/observations \
  -d '{"metric":"soil_moisture","value":0.12,"unit":"fraction_vwc","observedAt":"2026-05-01T09:00:00Z"}'
# → 202 {"rawObservationId": "...", "provenance": "user-entered"}

curl -s "${H[@]}" "$API/v1/tenants/$TENANT/farms/$FARM/observations?metric=soil_moisture"
curl -s "${H[@]}" "$API/v1/tenants/$TENANT/farms/$FARM/alerts?status=open"
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/alerts/<alertId>/ack -d '{"note":"checked irrigation"}'
```

## Uploads (signed URLs)

```bash
FILE=evidence.pdf
SHA=$(sha256sum $FILE | cut -d' ' -f1); SIZE=$(stat -c%s $FILE)
TICKET=$(curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/uploads \
  -d "{\"filename\":\"$FILE\",\"contentType\":\"application/pdf\",\"byteSize\":$SIZE,\"purpose\":\"verification-evidence\",\"sha256\":\"$SHA\"}")
URL=$(echo "$TICKET" | node -pe 'JSON.parse(require("fs").readFileSync(0)).uploadUrl')
MEDIA=$(echo "$TICKET" | node -pe 'JSON.parse(require("fs").readFileSync(0)).mediaId')

curl -s -X PUT -H "content-type: application/pdf" --data-binary @$FILE "$URL"   # straight to object storage
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/uploads/$MEDIA/complete      # API verifies size/type
```

## Verification evidence (verifier role)

```bash
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/farms/$FARM/boundaries/<boundaryId>/evidence \
  -d "{\"kind\":\"survey-document\",\"mediaObjectId\":\"$MEDIA\"}"
# → boundary provenance becomes "independently-verified"
```

## Audit

```bash
curl -s "${H[@]}" "$API/v1/tenants/$TENANT/audit-events?limit=20"   # admin/owner only
```

## Wallet linking

```bash
curl -s "${H[@]}" -X POST $API/v1/wallet/nonce -d '{"address":"0xYourAddress","chainId":31337}'
# → {"nonce":"…","message":"localhost:3000 wants you to sign in…","expiresAt":"…"}
# Sign `message` with the wallet (personal_sign), then:
curl -s "${H[@]}" -X POST $API/v1/wallet/verify -d '{"message":"<exact message>","signature":"0x…"}'
# Replaying the same message/signature fails: the nonce is single-use.
```

## NFT metadata validation

```bash
curl -s "${H[@]}" -X POST $API/v1/tenants/$TENANT/nft/metadata/validate \
  -d @packages/contracts/examples/nft-metadata.valid.json
```

## Webhooks

```bash
BODY='{"id":"evt_123","type":"sensor.reading","data":{}}'
TS=$(date +%s)
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "local-webhook-secret" -hex | sed 's/^.* //')
curl -s -X POST $API/v1/webhooks/acme -H "content-type: application/json" \
  -H "x-webhook-signature: t=$TS,v1=$SIG" -d "$BODY"
# → 202 accepted; the same id again → 200 duplicate; a bad signature → 401
```
