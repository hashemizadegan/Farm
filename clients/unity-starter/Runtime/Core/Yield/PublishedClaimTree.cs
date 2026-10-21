// The claim tree a client trusts, taken from the published cycle artifact (claim-lookup.ts
// PublishedClaimTree), not from a claim payload.
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Yield
{
    public sealed class PublishedClaimTree
    {
        [JsonProperty("cycleId")] public string CycleId;
        [JsonProperty("cycleVersion")] public uint CycleVersion;
        [JsonProperty("simulation")] public bool Simulation;
        [JsonProperty("hasherId")] public string HasherId;
        [JsonProperty("root")] public string Root;
        [JsonProperty("treeSize")] public long TreeSize;
        [JsonProperty("ownershipSnapshotHash")] public string OwnershipSnapshotHash;
    }
}
