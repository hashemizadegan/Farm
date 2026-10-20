using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Transactions
{
    /// <summary>OpenAPI TransferPreview: a description of a transfer, not a transaction.</summary>
    public sealed class TransferPreview
    {
        [JsonProperty("scheme")] public string Scheme;
        [JsonProperty("representationId")] public string RepresentationId;
        [JsonProperty("from")] public string From;
        [JsonProperty("to")] public string To;
        [JsonProperty("amount")] public string Amount;
        [JsonProperty("createdAt")] public string CreatedAt;
        [JsonProperty("expiresAt")] public string ExpiresAt;
        [JsonProperty("digest")] public string Digest;
        [JsonProperty("ownershipAsOfSlot")] public string OwnershipAsOfSlot;
        [JsonProperty("submission")] public SubmissionState Submission;
    }

    public sealed class SubmissionState
    {
        /// <summary>Always false in this release.</summary>
        [JsonProperty("available")] public bool Available;
        [JsonProperty("reason")] public string Reason;
    }
}
