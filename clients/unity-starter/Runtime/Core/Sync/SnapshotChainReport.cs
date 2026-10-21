using System.Collections.Generic;
using Metafarm.Twin.Core.Anchoring;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    /// <summary>
    /// What the client could verify about one snapshot, link by link: the bytes against the committed
    /// hash, the snapshot's own structure, its inclusion in a batch, and (if asked) the batch's anchor
    /// plan. An anchor plan is never an anchor: nothing here says a root is on-chain.
    /// </summary>
    public sealed class SnapshotChainReport
    {
        internal SnapshotChainReport() { }

        public string CommitmentId { get; internal set; }
        /// <summary>The content hash the commitment records (the batch leaf is computed from it).</summary>
        public string ContentSha256 { get; internal set; }
        /// <summary>SHA-256 of the received bytes equals <see cref="ContentSha256"/>.</summary>
        public ChainLinkState Content { get; internal set; }
        /// <summary>Order, Merkle root over the entities, snapshot id, and the farm it belongs to.</summary>
        public ChainLinkState Structure { get; internal set; }
        /// <summary>The RFC 9162 inclusion proof of the commitment in its batch.</summary>
        public ChainLinkState Inclusion { get; internal set; }
        /// <summary>The batch's anchor plan is plan-only and names the verified batch root.</summary>
        public ChainLinkState AnchorPlan { get; internal set; }

        /// <summary>The snapshot, set only when <see cref="Content"/> and <see cref="Structure"/> are verified.</summary>
        public FarmSnapshot Snapshot { get; internal set; }
        public string BatchId { get; internal set; }
        /// <summary>The batch root the client re-derived from the proof; null unless inclusion is verified.</summary>
        public string BatchRoot { get; internal set; }
        public AnchorPlanReview AnchorPlanReview { get; internal set; }
        public IReadOnlyList<string> Problems => _problems;
        internal readonly List<string> _problems = new List<string>();

        /// <summary>The snapshot is the committed one and is in a batch whose root the client verified.</summary>
        public bool VerifiedThroughBatch => Content == ChainLinkState.Verified && Structure == ChainLinkState.Verified && Inclusion == ChainLinkState.Verified;

        /// <summary>One line for the UI, never claiming more than was verified.</summary>
        public string Summary
        {
            get
            {
                if (Content != ChainLinkState.Verified || Structure != ChainLinkState.Verified) return "Snapshot not verified";
                var shortRoot = Snapshot.Root.Substring(0, 12);
                switch (Inclusion)
                {
                    case ChainLinkState.NotBatched:
                        return $"Snapshot {shortRoot}… matches its commitment; not in a batch yet";
                    case ChainLinkState.Verified:
                        var tail = AnchorPlan == ChainLinkState.Verified ? "anchoring planned only, not anchored" : "not anchored";
                        return $"Snapshot {shortRoot}… matches its commitment and is in batch root {BatchRoot.Substring(0, 12)}…; {tail}";
                    default:
                        return $"Snapshot {shortRoot}… matches its commitment; batch inclusion not verified";
                }
            }
        }
    }
}
