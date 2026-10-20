// Farm-state snapshot (metafarm-farm-snapshot/1, packages/domain/src/twin/snapshot.ts). Entity data
// is kept as raw JSON: its meaning belongs to the platform; the client shows it and checks hashes.
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Core.Models
{
    public sealed class FarmSnapshot
    {
        public const string Scheme1 = "metafarm-farm-snapshot/1";

        [JsonProperty("scheme")] public string Scheme;
        /// <summary>SHA-256 of the canonical header: the snapshot's content address.</summary>
        [JsonProperty("snapshotId")] public string SnapshotId;
        [JsonProperty("farmId")] public string FarmId;
        [JsonProperty("takenAt")] public string TakenAt;
        [JsonProperty("entitySchemaVersion")] public int EntitySchemaVersion;
        [JsonProperty("entityCount")] public int EntityCount;
        /// <summary>RFC 9162 Merkle root over the entity hashes, in (type, id) order.</summary>
        [JsonProperty("root")] public string Root;
        [JsonProperty("entities")] public List<SnapshotEntity> Entities = new List<SnapshotEntity>();
    }

    public sealed class SnapshotEntity
    {
        /// <summary>plot, crop, structure, inventory, machine, animal or asset.</summary>
        [JsonProperty("type")] public string Type;
        [JsonProperty("id")] public string Id;
        [JsonProperty("data")] public JObject Data;
        [JsonProperty("sha256")] public string Sha256;
    }
}
