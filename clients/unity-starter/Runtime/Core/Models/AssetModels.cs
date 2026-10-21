// Asset-detail DTOs for GET /v1/tenants/{tenantId}/twin/assets/{assetId} (OpenAPI TwinAssetDetail,
// TwinOwnership). Amounts and slots are strings: they are u64 values a double cannot hold.
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Models
{
    public sealed class TwinAssetDetail
    {
        [JsonProperty("object")] public TwinObject Object;
        [JsonProperty("lifecycle")] public List<LifecycleEvent> Lifecycle = new List<LifecycleEvent>();
        [JsonProperty("ownership")] public List<OwnershipReading> Ownership = new List<OwnershipReading>();
        [JsonProperty("dataCommitments")] public List<DataCommitment> DataCommitments = new List<DataCommitment>();
    }

    public sealed class LifecycleEvent
    {
        /// <summary>registered or verified.</summary>
        [JsonProperty("event")] public string Event;
        [JsonProperty("at")] public string At;
    }

    /// <summary>Ownership of one representation as the chain, or an indexer of it, reports it.</summary>
    public sealed class OwnershipReading
    {
        [JsonProperty("representationId")] public string RepresentationId;
        /// <summary>indexed, not_indexed or not_on_chain.</summary>
        [JsonProperty("status")] public string Status;
        /// <summary>When not_indexed: no_ownership_reader, not_covered or reader_unavailable.</summary>
        [JsonProperty("reason")] public string Reason;
        /// <summary>chain_index, das or fixture.</summary>
        [JsonProperty("source")] public string Source;
        /// <summary>inclusion_verified, indexer_reported or fixture.</summary>
        [JsonProperty("assurance")] public string Assurance;
        [JsonProperty("asOfSlot")] public string AsOfSlot;
        [JsonProperty("holders")] public List<Holder> Holders = new List<Holder>();
        /// <summary>
        /// Whether the signed-in user's linked player wallets hold it (linked in the web app). Null when
        /// the API does not say: never read null as "no". Read-only: the client never links wallets.
        /// </summary>
        [JsonProperty("heldByYou")] public bool? HeldByYou;
    }

    public sealed class Holder
    {
        [JsonProperty("owner")] public string Owner;
        [JsonProperty("amount")] public string Amount;
    }
}
