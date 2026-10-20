using System.Collections.Generic;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotSyncResult
    {
        public SnapshotSyncResult(SnapshotSyncOutcome outcome, string commitmentId, FarmSnapshot snapshot, IReadOnlyList<string> problems)
        {
            Outcome = outcome;
            CommitmentId = commitmentId;
            Snapshot = snapshot;
            Problems = problems ?? new List<string>();
        }

        public SnapshotSyncOutcome Outcome { get; }
        /// <summary>The newest commitment seen (null when there is none).</summary>
        public string CommitmentId { get; }
        /// <summary>Set only when Outcome is Updated.</summary>
        public FarmSnapshot Snapshot { get; }
        public IReadOnlyList<string> Problems { get; }
    }
}
