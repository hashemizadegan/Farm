# Signing keys in Google Cloud KMS

The worker signs Solana issuance (Ed25519) and TRON payouts (secp256k1) with keys that live in
Cloud KMS; the private keys never leave it. The app holds only a service account key that may
sign with, and read the public half of, these two keys. In-process keys
(`RWA_SOLANA_SIGNER_SECRET`, `RWA_TRON_SIGNER_PRIVATE_KEY`) remain for devnet/testnet and are
refused when `RWA_MAINNET_ENABLED` is on.

| Rail | Algorithm | Protection level |
| --- | --- | --- |
| Solana issuer (mint, freeze, permanent delegate, tree creator) | `ec-sign-ed25519` | software (KMS offers Ed25519 only in software) |
| TRON treasury (payouts) | `ec-sign-secp256k1-sha256` | hsm |

## One-time setup (by the operator, in their own Google Cloud project)

```sh
PROJECT=your-project
LOCATION=europe-west1          # a region where Cloud HSM is available
gcloud services enable cloudkms.googleapis.com --project $PROJECT
gcloud kms keyrings create rwa --location $LOCATION --project $PROJECT

gcloud kms keys create solana-issuer --keyring rwa --location $LOCATION --project $PROJECT \
  --purpose asymmetric-signing --default-algorithm ec-sign-ed25519 --protection-level software
gcloud kms keys create tron-treasury --keyring rwa --location $LOCATION --project $PROJECT \
  --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256 --protection-level hsm

gcloud iam service-accounts create rwa-signer --project $PROJECT
for KEY in solana-issuer tron-treasury; do
  gcloud kms keys add-iam-policy-binding $KEY --keyring rwa --location $LOCATION --project $PROJECT \
    --member serviceAccount:rwa-signer@$PROJECT.iam.gserviceaccount.com --role roles/cloudkms.signerVerifier
done
gcloud iam service-accounts keys create rwa-signer.json --iam-account rwa-signer@$PROJECT.iam.gserviceaccount.com
```

`roles/cloudkms.signerVerifier` can sign and read public keys only: it cannot export, destroy or
create keys. Keep the service account for this and nothing else, and rotate its key.

## Worker settings (Railway → worker → Variables)

| Variable | Value |
| --- | --- |
| `GCP_KMS_CREDENTIALS_JSON` | the whole contents of `rwa-signer.json` (then delete the file) |
| `RWA_SOLANA_KMS_KEY` | `projects/$PROJECT/locations/$LOCATION/keyRings/rwa/cryptoKeys/solana-issuer/cryptoKeyVersions/1` |
| `RWA_TRON_KMS_KEY` | `projects/$PROJECT/locations/$LOCATION/keyRings/rwa/cryptoKeys/tron-treasury/cryptoKeyVersions/1` |
| `RWA_SOLANA_ISSUER` | the Solana address of the issuer key (API and worker; the worker checks it matches) |
| `RWA_TRON_TREASURY` | the TRON address of the treasury key (the worker checks it matches) |

Remove `RWA_SOLANA_SIGNER_SECRET` and `RWA_TRON_SIGNER_PRIVATE_KEY` when the KMS keys are set;
setting both for one rail is refused. On start the worker reads each key's public half, derives
its address and logs it with "RWA execution started"; fund those addresses (SOL for fees and rent,
TRX for energy, the stablecoin for payouts) on the network you run.

## What the worker checks on every signature

- CRC32C of what it sends and of what comes back (`verifiedDataCrc32c` / `verifiedDigestCrc32c`,
  `signatureCrc32c`); a mismatch is discarded and asked again, at most three times.
- The answering key version is exactly the configured one, and its algorithm is the expected one.
- Ed25519 signatures verify against the key before use; secp256k1 signatures are normalised to
  low-s and must recover to the treasury key (that gives TRON's recovery byte).

If KMS cannot be reached at start, execution stays off and is retried every minute; the rest of
the worker keeps running.
