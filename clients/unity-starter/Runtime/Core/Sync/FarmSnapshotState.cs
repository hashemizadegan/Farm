using System;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    /// <summary>
    /// The verified snapshot a client holds for one farm. Only SnapshotSync replaces it, and only with a
    /// candidate that verified and is newer (or the first one); every other outcome leaves it as it was.
    /// The baseline is kept as the verified bytes and a private parse of them: nothing handed to callers
    /// (Snapshot, a result's Snapshot, a diff's entities) is the baseline, so changing those objects can
    /// never change what the next sync compares against.
    /// </summary>
    public sealed class FarmSnapshotState
    {
        private string _verifiedBody;
        private FarmSnapshot _baseline;

        public FarmSnapshotState(string farmId)
        {
            if (string.IsNullOrEmpty(farmId)) throw new ArgumentException("farmId is required", nameof(farmId));
            FarmId = farmId;
        }

        public string FarmId { get; }
        /// <summary>The record of the held snapshot, or null before the first sync.</summary>
        public string CommitmentId { get; private set; }
        /// <summary>The content hash the held bytes were verified against, or null before the first sync.</summary>
        public string ContentSha256 { get; private set; }
        public bool HasSnapshot => _verifiedBody != null;

        /// <summary>A new copy of the held, verified snapshot on every call (null before the first sync).</summary>
        public FarmSnapshot Snapshot => _verifiedBody == null ? null : TwinJson.Deserialize<FarmSnapshot>(_verifiedBody);

        /// <summary>The private baseline, for comparisons only; never returned to callers.</summary>
        internal FarmSnapshot Baseline => _baseline;

        internal void Replace(string commitmentId, string contentSha256, string verifiedBody)
        {
            CommitmentId = commitmentId;
            ContentSha256 = contentSha256;
            _verifiedBody = verifiedBody;
            _baseline = TwinJson.Deserialize<FarmSnapshot>(verifiedBody);
        }
    }
}
