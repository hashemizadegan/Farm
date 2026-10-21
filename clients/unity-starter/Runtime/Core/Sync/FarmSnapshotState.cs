using System;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    /// <summary>
    /// The verified snapshot a client holds for one farm. Only SnapshotSync replaces it, and only with a
    /// candidate that verified and is newer (or the first one); every other outcome leaves it as it was.
    /// </summary>
    public sealed class FarmSnapshotState
    {
        public FarmSnapshotState(string farmId)
        {
            if (string.IsNullOrEmpty(farmId)) throw new ArgumentException("farmId is required", nameof(farmId));
            FarmId = farmId;
        }

        public string FarmId { get; }
        /// <summary>The record of the held snapshot, or null before the first sync.</summary>
        public string CommitmentId { get; private set; }
        /// <summary>The held, verified snapshot, or null before the first sync.</summary>
        public FarmSnapshot Snapshot { get; private set; }

        internal void Replace(string commitmentId, FarmSnapshot snapshot)
        {
            CommitmentId = commitmentId;
            Snapshot = snapshot;
        }
    }
}
