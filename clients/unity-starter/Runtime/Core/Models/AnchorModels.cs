// Anchor-plan wire shapes: GET /twin/snapshots/{commitmentId}/anchor-plan and
// GET /twin/data-commitments/batches/{batchId}/anchor-plan. A plan describes what would be written on
// Solana to anchor a Merkle root. It is data only: the platform never executes it in this release.
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Models
{
    public sealed class AnchorPlan
    {
        /// <summary>"metafarm-anchor/1".</summary>
        [JsonProperty("scheme")] public string Scheme;
        /// <summary>"token2022_metadata" or "bubblegum_v1_leaf" (see <see cref="AnchorCarriers"/>).</summary>
        [JsonProperty("carrier")] public string Carrier;
        [JsonProperty("network")] public string Network;
        /// <summary>"batch" or "snapshot".</summary>
        [JsonProperty("subject")] public string Subject;
        [JsonProperty("root")] public string Root;
        /// <summary>Token-2022 carrier: the metadata field that would hold the root.</summary>
        [JsonProperty("metadataField")] public AnchorMetadataField MetadataField;
        /// <summary>Bubblegum carrier: the leaf metadata that would point at the anchor document.</summary>
        [JsonProperty("leafMetadata")] public AnchorLeafMetadata LeafMetadata;
        /// <summary>Always false from the platform today; see AnchorPlanReview.</summary>
        [JsonProperty("executable")] public bool Executable;
        [JsonProperty("reason")] public string Reason;
    }

    public sealed class AnchorMetadataField
    {
        [JsonProperty("key")] public string Key;
        [JsonProperty("value")] public string Value;
    }

    public sealed class AnchorLeafMetadata
    {
        [JsonProperty("name")] public string Name;
        [JsonProperty("symbol")] public string Symbol;
        [JsonProperty("uri")] public string Uri;
    }

    public sealed class SnapshotAnchorPlan
    {
        [JsonProperty("commitmentId")] public string CommitmentId;
        [JsonProperty("snapshotId")] public string SnapshotId;
        [JsonProperty("plan")] public AnchorPlan Plan;
    }

    public sealed class BatchAnchorPlan
    {
        [JsonProperty("batchId")] public string BatchId;
        [JsonProperty("plan")] public AnchorPlan Plan;
    }

    /// <summary>The carriers and networks the platform accepts for anchor plans.</summary>
    public static class AnchorCarriers
    {
        public const string Token2022Metadata = "token2022_metadata";
        public const string BubblegumV1Leaf = "bubblegum_v1_leaf";
        public const string SolanaDevnet = "solana-devnet";
        public const string SolanaMainnet = "solana-mainnet";

        public static bool IsCarrier(string value) => value == Token2022Metadata || value == BubblegumV1Leaf;
        public static bool IsNetwork(string value) => value == SolanaDevnet || value == SolanaMainnet;
    }
}
