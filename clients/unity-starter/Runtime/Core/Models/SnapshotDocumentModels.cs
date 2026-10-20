// Snapshot API wire shapes: GET /twin/farms/{farmId}/snapshots and GET /twin/snapshots/{commitmentId}.
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Models
{
    public sealed class SnapshotList
    {
        [JsonProperty("items")] public List<DataCommitment> Items = new List<DataCommitment>();
        [JsonProperty("nextCursor")] public string NextCursor;
    }

    public sealed class FarmSnapshotDocument
    {
        [JsonProperty("commitment")] public DataCommitment Commitment;
        /// <summary>The server's own re-verification of the stored snapshot.</summary>
        [JsonProperty("check")] public SnapshotCheck Check;
        [JsonProperty("snapshot")] public FarmSnapshot Snapshot;
    }

    public sealed class SnapshotCheck
    {
        [JsonProperty("ok")] public bool Ok;
        [JsonProperty("problems")] public List<string> Problems = new List<string>();
    }
}
