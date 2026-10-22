// Y11: read-only yield DTOs (plan §8), matching the operator read API (GET /v1/tenants/{tenantId}/yield/...,
// OpenAPI YieldCycle and YieldArtifactSet). DTOs only: nothing here requests, approves, funds or pays.
// User-facing wording waits for approved disclosures (D-39); allocations are only ever shown through an explicit
// account-to-party link (D-29), which does not exist yet. Amounts and weights stay decimal strings (they exceed
// 2^53 and must never pass through floating point).
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Models
{
    public sealed class YieldPeriod
    {
        [JsonProperty("start")] public string Start;
        [JsonProperty("end")] public string End;
    }

    public sealed class YieldChainAsset
    {
        [JsonProperty("network")] public string Network;
        [JsonProperty("rail")] public string Rail;
        [JsonProperty("id")] public string Id;
    }

    public sealed class YieldSlotRange
    {
        [JsonProperty("start")] public string Start;
        [JsonProperty("end")] public string End;
    }

    /// <summary>A cycle as the platform reports it (status values: YieldStatuses).</summary>
    public sealed class YieldCycleSummary
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("period")] public YieldPeriod Period;
        [JsonProperty("version")] public int Version;
        /// <summary>Simulation cycles are illustrative and can never be funded or paid.</summary>
        [JsonProperty("simulation")] public bool IsSimulation;
        [JsonProperty("status")] public string Status;
        [JsonProperty("priorStatus")] public string PriorStatus;
        [JsonProperty("closeReason")] public string CloseReason;
        [JsonProperty("chainAsset")] public YieldChainAsset ChainAsset;
        [JsonProperty("formulaVersion")] public string FormulaVersion;
        [JsonProperty("accountingCurrency")] public string AccountingCurrency;
        [JsonProperty("slotRange")] public YieldSlotRange SlotRange;
        [JsonProperty("artifactSetHash")] public string ArtifactSetHash;
        [JsonProperty("merkleRoot")] public string MerkleRoot;
        [JsonProperty("updatedAt")] public string LastUpdated;
    }

    public sealed class YieldArtifactHashes
    {
        [JsonProperty("calculation")] public string Calculation;
        [JsonProperty("allocation")] public string Allocation;
        [JsonProperty("evidenceBundle")] public string EvidenceBundle;
        [JsonProperty("merkleRoot")] public string MerkleRoot;
        [JsonProperty("set")] public string Set;
    }

    public sealed class YieldOwnershipSnapshot
    {
        /// <summary>rpc (verified cluster identity) or fixture (simulation only).</summary>
        [JsonProperty("sourceKind")] public string SourceKind;
        [JsonProperty("network")] public string Network;
        [JsonProperty("slotRange")] public YieldSlotRange SlotRange;
        [JsonProperty("cursorSlot")] public string CursorSlot;
        [JsonProperty("holdingModel")] public string HoldingModel;
        [JsonProperty("inputCommitment")] public string InputCommitment;
        [JsonProperty("totalWeight")] public string TotalWeight;
    }

    /// <summary>What a reader can check: the root and artifact-set hash, and how many attestations it carries.</summary>
    public sealed class YieldVerification
    {
        [JsonProperty("id")] public string ArtifactSetId;
        [JsonProperty("setNumber")] public int SetNumber;
        [JsonProperty("status")] public string Status;
        [JsonProperty("hashes")] public YieldArtifactHashes Hashes;
        [JsonProperty("ownershipSnapshot")] public YieldOwnershipSnapshot OwnershipSnapshot;
        [JsonProperty("attesters")] public int AttestationCount;
    }

    public sealed class YieldCycleDetail
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("period")] public YieldPeriod Period;
        [JsonProperty("version")] public int Version;
        [JsonProperty("simulation")] public bool IsSimulation;
        [JsonProperty("status")] public string Status;
        [JsonProperty("closeReason")] public string CloseReason;
        [JsonProperty("artifactSetHash")] public string ArtifactSetHash;
        [JsonProperty("merkleRoot")] public string MerkleRoot;
        [JsonProperty("updatedAt")] public string LastUpdated;
        [JsonProperty("artifactSets")] public List<YieldVerification> ArtifactSets = new List<YieldVerification>();
    }

    public sealed class YieldCycleList
    {
        [JsonProperty("items")] public List<YieldCycleSummary> Items = new List<YieldCycleSummary>();
        [JsonProperty("nextCursor")] public string NextCursor;
    }

    /// <summary>An allocation row (operators; holders only through the D-29 party link, not built yet).</summary>
    public sealed class YieldAllocationView
    {
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("partyId")] public string PartyId;
        [JsonProperty("holderKey")] public string HolderKey;
        /// <summary>Decimal integer, slot-weighted units.</summary>
        [JsonProperty("weight")] public string Weight;
        /// <summary>Decimal integer, settlement minor units (u64).</summary>
        [JsonProperty("amount")] public string Amount;
    }

    /// <summary>GET …/yield/cycles/{cycleId}/artifact-sets/{setId}/allocations.</summary>
    public sealed class YieldAllocationList
    {
        [JsonProperty("items")] public List<YieldAllocationView> Items = new List<YieldAllocationView>();
    }

    /// <summary>The cycle statuses of plan §2.1 and how a client should treat them. No display text (D-39).</summary>
    public static class YieldStatuses
    {
        public const string Draft = "draft";
        public const string Published = "published";
        public const string Disputed = "disputed";
        public const string Superseded = "superseded";
        public const string Closed = "closed";

        public static readonly IReadOnlyList<string> All = new[]
        {
            "draft", "inputs_locked", "calculated", "under_review", "approved", "published",
            "funded", "distributing", "disputed", "closed", "cancelled", "abandoned", "superseded",
        };

        /// <summary>Only a published (or disputed) cycle has a root a reader may check; nothing else is shown as verified.</summary>
        public static bool HasPublishedRoot(YieldCycleSummary c) => c != null && (c.Status == Published || c.Status == Disputed) && !string.IsNullOrEmpty(c.MerkleRoot);

        /// <summary>Disputed cycles pause any payout (plan §8: "Disputed: payouts paused").</summary>
        public static bool PayoutsPaused(YieldCycleSummary c) => c != null && c.Status == Disputed;

        /// <summary>A known status; an unknown one is never treated as published or verified.</summary>
        public static bool IsKnown(string status)
        {
            foreach (var s in All) if (s == status) return true;
            return false;
        }
    }
}
