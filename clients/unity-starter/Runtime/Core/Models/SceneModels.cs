// Scene DTOs for GET /v1/tenants/{tenantId}/twin/farms/{farmId}/scene.
// They mirror packages/contracts/openapi.yaml (TwinScene, TwinObject, TwinChainIdentity). They are
// wire shapes only: the domain rules live in the platform (packages/domain), not in the client.
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Core.Models
{
    public sealed class TwinScene
    {
        public const string Scheme1 = "metafarm-twin-scene/1";

        [JsonProperty("scheme")] public string Scheme;
        [JsonProperty("generatedAt")] public string GeneratedAt;
        [JsonProperty("farm")] public TwinFarm Farm;
        /// <summary>Layers this account may not see (assets need the rwa:read permission).</summary>
        [JsonProperty("redacted")] public List<string> Redacted = new List<string>();
        [JsonProperty("objects")] public List<TwinObject> Objects = new List<TwinObject>();
        /// <summary>Pass as the cursor for the next page; null on the last page.</summary>
        [JsonProperty("nextCursor")] public string NextCursor;
    }

    public sealed class TwinFarm
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("name")] public string Name;
        /// <summary>May be null.</summary>
        [JsonProperty("origin")] public LonLat Origin;
        /// <summary>Simplified outer ring of the current boundary as [lon, lat] pairs; may be null.</summary>
        [JsonProperty("outline")] public List<double[]> Outline;
    }

    public sealed class LonLat
    {
        [JsonProperty("lon")] public double Lon;
        [JsonProperty("lat")] public double Lat;
    }

    public sealed class TwinObject
    {
        /// <summary>"asset:&lt;assetId&gt;".</summary>
        [JsonProperty("twinObjectId")] public string TwinObjectId;
        [JsonProperty("assetId")] public string AssetId;
        /// <summary>plots, crops_trees, livestock, equipment, buildings, storage, output_batches, logistics, shares.</summary>
        [JsonProperty("layer")] public string Layer;
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("name")] public string Name;
        [JsonProperty("status")] public string Status;
        /// <summary>GeoJSON (WGS 84) Point or Polygon, or null.</summary>
        [JsonProperty("geometry")] public JObject Geometry;
        [JsonProperty("physical")] public PhysicalIdentity Physical;
        [JsonProperty("chain")] public List<ChainIdentity> Chain = new List<ChainIdentity>();
    }

    public sealed class PhysicalIdentity
    {
        [JsonProperty("externalRef")] public string ExternalRef;
        [JsonProperty("parcelLabel")] public string ParcelLabel;
        [JsonProperty("geomProvenance")] public string GeomProvenance;
        [JsonProperty("verifiedAt")] public string VerifiedAt;
    }

    public sealed class ChainIdentity
    {
        [JsonProperty("representationId")] public string RepresentationId;
        /// <summary>SOLANA_TOKEN_2022, SOLANA_BUBBLEGUM_CNFT or TRON_TRC20.</summary>
        [JsonProperty("rail")] public string Rail;
        [JsonProperty("network")] public string Network;
        [JsonProperty("status")] public string Status;
        /// <summary>Mint (Token-2022), asset id (Bubblegum) or contract (TRC-20); null until known.</summary>
        [JsonProperty("chainId")] public string ChainId;
    }
}
