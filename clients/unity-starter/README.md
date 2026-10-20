# Unity starter for the Metafarm digital twin

A starting point for the separate 3D client, to copy into a **Unity 6 (URP)** project. It is not a
game: it loads one farm's twin scene from the API (or from a sample file) and draws placeholders.
It holds no keys, signs nothing and changes nothing. The contract it follows is
[`docs/game-client.md`](../../docs/game-client.md).

## Contents

| Path | What it is |
| --- | --- |
| `Runtime/Api/TwinModels.cs` | DTOs for `/v1/tenants/{tenantId}/twin/*` (mirrors `packages/contracts/openapi.yaml`) |
| `Runtime/Api/TwinApiClient.cs` | Read-only HTTP client (scene, asset detail); bearer token from an `ITokenSource` |
| `Runtime/Scene/LocalFrame.cs` | Longitude/latitude to metres around the farm origin (same convention as `packages/map-scene`) |
| `Runtime/Scene/FarmSceneLoader.cs` | Draws the boundary, plot outlines and point assets from a scene |
| `Samples/*.json` | Mock payloads in the API's shape; CI checks them against the API schema (`packages/domain/src/twin/client-samples.test.ts`) |

The sample data is made up: the farm, assets and Solana addresses do not exist.

## Use

1. Create a Unity 6 project with the Universal Render Pipeline.
2. Add the package `com.unity.nuget.newtonsoft-json` (Package Manager → Add by name).
3. Copy `Runtime/` into `Assets/Metafarm/` and `Samples/scene.sample.json` into `Assets/Metafarm/Samples/`.
4. Add an empty GameObject with `FarmSceneLoader`, assign the sample as **Sample Scene**, press Play: the
   boundary, Block A and the point assets appear around the origin.
5. To use a server instead, implement `ITokenSource` with your OIDC sign-in (authorization code with
   PKCE in the system browser), then call `TwinApiClient.GetSceneAsync(farmId)` and pass the result to
   `FarmSceneLoader.Render`.

This folder is not compiled by the repository's CI (there is no Unity there). Compile it in Unity
before relying on it.

## First milestone

Load one real farm on staging with a staging account and show, for each object, its name, kind,
status and chain identity; tap an object to fetch `GET /twin/assets/{assetId}` and show its ownership
exactly as returned (`not indexed` is shown as unknown, never as "no owner").
