using System.Collections.Generic;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotSyncResult
    {
        internal SnapshotSyncResult(SnapshotSyncOutcome outcome, string commitmentId, FarmSnapshot snapshot, SnapshotDiff diff, SnapshotFailure failure, IReadOnlyList<string> problems)
        {
            Outcome = outcome;
            CommitmentId = commitmentId;
            Snapshot = snapshot;
            Diff = diff;
            Failure = failure;
            Problems = problems ?? new List<string>();
        }

        public SnapshotSyncOutcome Outcome { get; }
        /// <summary>The newest record seen (null when there is none).</summary>
        public string CommitmentId { get; }
        /// <summary>The newly held snapshot; set only for Initial and Updated.</summary>
        public FarmSnapshot Snapshot { get; }
        /// <summary>What to apply to the scene; set only for Initial and Updated, so a rejected candidate never yields one.</summary>
        public SnapshotDiff Diff { get; }
        /// <summary>Why verification failed (VerificationFailed and FarmMismatch); None otherwise.</summary>
        public SnapshotFailure Failure { get; }
        public IReadOnlyList<string> Problems { get; }
        /// <summary>True when the held state was replaced.</summary>
        public bool Accepted => Outcome == SnapshotSyncOutcome.Initial || Outcome == SnapshotSyncOutcome.Updated;
    }
}
