// A holder's claim payload (metafarm-yield-claim/1), as packages/domain/src/yield/claim-lookup.ts serves it
// from a frozen cycle distribution artifact. 64-bit amounts are decimal strings; bytes are lowercase hex.
// Root and TreeSize repeat the published tree for convenience only: verify against the tree you trust
// (PublishedClaimTree), never against these. Simulation only while D-26 is open.
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Yield
{
    public sealed class ClaimPayload
    {
        public const string SchemeId = "metafarm-yield-claim/1";

        [JsonProperty("scheme")] public string Scheme;
        [JsonProperty("cycleId")] public string CycleId;
        [JsonProperty("cycleVersion")] public uint CycleVersion;
        [JsonProperty("simulation")] public bool Simulation;
        [JsonProperty("hasherId")] public string HasherId;
        [JsonProperty("root")] public string Root;
        [JsonProperty("treeSize")] public long TreeSize;
        [JsonProperty("leafIndex")] public long LeafIndex;
        [JsonProperty("partyId")] public string PartyId;
        [JsonProperty("recipient")] public string Recipient;
        [JsonProperty("amount")] public string Amount;
        [JsonProperty("leafBytes")] public string LeafBytes;
        [JsonProperty("leafHash")] public string LeafHash;
        [JsonProperty("path")] public List<string> Path;
    }
}
