# Unity starter for the Metafarm digital twin

A **starting point**, not a game and not a complete metaverse. It is meant to be copied into a
**Unity 6 (URP)** project, the engine recommended for the first client (see
[`docs/game-client.md`](../../docs/game-client.md)). It loads one farm's twin scene, from the API or
from sample files, and draws placeholders. It is read-only by construction: the transport can only
send GET requests, there is no wallet, signing or submission code, and transfer preparation is
disabled.

## Layout and boundaries

| Folder (namespace) | Engine | Responsibility |
| --- | --- | --- |
| `Runtime/Core/Models` (`Metafarm.Twin.Core.Models`) | none | Wire DTOs mirroring `packages/contracts/openapi.yaml` (TwinScene, TwinObject, TwinAssetDetail, OwnershipReading, DataCommitment, DataCommitmentProof). No domain rules: those stay in the platform. |
| `Runtime/Core/Transport` (`…Core.Transport`) | none | `ITwinTransport`: GET only |
| `Runtime/Core/Auth` (`…Core.Auth`) | none | `ITokenSource` for the user's OIDC access token; `NoTokenSource` for offline use. No token is stored in the starter. |
| `Runtime/Core/Api` (`…Core.Api`) | none | `ITwinReadApi` and `TwinReadClient` (scene, asset detail, commitment proof, snapshots, anchor plans); ids must be UUIDs, and anchor carriers and networks must be known values |
| `Runtime/Core/Ownership` (`…Core.Ownership`) | none | `IOwnershipReader`, `ApiOwnershipReader`, and `OwnershipDisplay`, which never shows "not indexed" as "no owner" and labels fixture data as test data |
| `Runtime/Core/Transactions` (`…Core.Transactions`) | none | `ITransferPreviewer` (preparation only) and `DisabledTransferPreviewer`, the default. There is no signing or submission interface. |
| `Runtime/Core/Verification` (`…Core.Verification`) | none | `ICommitmentVerifier` and `Rfc9162CommitmentVerifier`: checks content hashes and Merkle proofs locally, using the platform's scheme `metafarm-merkle-sha256/1` |
| `Runtime/Core/Anchoring` (`…Core.Anchoring`) | none | `AnchorPlanReview`: checks an anchor plan (`AnchorModels.cs`) against the root the client verified, refuses any plan that claims to be executable, and words it as "planned only, not anchored" |
| `Runtime/Core/Sync` (`…Core.Sync`) | none | `SnapshotSync`: compares the newest snapshot commitment with the one held, fetches only when it changed, and accepts it only if the server's check and `SnapshotVerifier` both pass. `SnapshotChain`: verifies one snapshot link by link (exact bytes against the committed hash, structure, batch inclusion, optional anchor plan) and reports each link's state |
| `Runtime/Core/Mocks` (`…Core.Mocks`) | none | `SampleTransport` (serves JSON by path, records requests) and `SampleIds` for running without a backend |
| `Runtime/Unity` (`Metafarm.Twin.Unity`) | Unity | `UnityWebRequestTransport` (https only, bearer token), `LocalFrame` (metres around the farm origin, as in `packages/map-scene`), and the `FarmSceneLoader` MonoBehaviour |
| `Samples/` | none | Mock payloads in the API's shape. The farm, assets and addresses are made up. |
| `Tests~/` | .NET | Builds `Runtime/Core` outside Unity and runs its tests. Unity ignores folders ending in `~`. |

Each layer depends only on the ones above it in this table; `Runtime/Core` has no reference to
UnityEngine (`noEngineReferences` in its assembly definition). DTO files group related wire
types (`SceneModels.cs`, `AssetModels.cs`, `CommitmentModels.cs`, `AnchorModels.cs`); every other file holds one type
named after it.

## Dependencies

- Unity 6 with the Universal Render Pipeline.
- `com.unity.nuget.newtonsoft-json` (Unity's own package of Newtonsoft.Json 13). Both assemblies
  reference `Newtonsoft.Json.dll`. `JsonUtility` cannot read nullable fields or GeoJSON coordinates.

Nothing else: no Solana SDK, no wallet adapter, no Cesium. Those come with later milestones.

## What is checked, and where

- **CI job "Unity starter core (C#)"**: builds `Runtime/Core` as netstandard2.1 with C# 9 (the profile
  Unity 6 compiles), warnings as errors, and runs the xUnit tests in `Tests~`. The tests cover the
  read client against the samples, UUID checks before any request, error handling, ownership
  classification, disabled transfer previews, and Merkle verification against vectors produced by
  the platform's TypeScript code. They also check by reflection that nothing in Core can sign,
  submit or hold keys, and that the transport has only `GetAsync`.
- **Vitest (`packages/domain/src/twin/client-samples.test.ts`)**: the sample payloads parse with the
  API's own schemas, and the sample proof verifies with the platform's verifier.
- **Not checked in CI**: `Runtime/Unity` needs the Unity editor. Open it in Unity 6 and fix anything
  the editor reports before relying on it.

## Use

1. Create a Unity 6 URP project and add `com.unity.nuget.newtonsoft-json` (Package Manager → Add
   package by name).
2. Copy `Runtime/` to `Assets/Metafarm/Twin/` and `Samples/scene.sample.json` to
   `Assets/Metafarm/Twin/Samples/`.
3. Add an empty GameObject with `FarmSceneLoader` and set **Sample Scene** to the sample. Press Play:
   the boundary, Block A and the point assets appear around the origin.
4. For a server: implement `ITokenSource` with the platform's OIDC sign-in (authorization code with
   PKCE in the system browser), then call
   `loader.Load(new TwinReadClient(new UnityWebRequestTransport(apiBaseUrl, tokens), tenantId), farmId)`.
   Take `apiBaseUrl` from configuration; never commit tokens, keys or credentialed URLs.

## Current limitations

- Placeholders only: outlines and markers, no terrain, models, physics, multiplayer or gameplay.
- No sign-in implementation, no wallet connection, no transfers (previews disabled; submission does
  not exist on the platform either).
- Ownership is only as good as the platform's ownership reader; the deployed API has none yet, so
  real assets show "Ownership unknown (not indexed)".
- `Runtime/Unity` is unverified until compiled in Unity.
