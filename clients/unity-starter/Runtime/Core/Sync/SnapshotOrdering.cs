// Rollback protection relative to the snapshot the client holds. It is not a freshness guarantee:
// it cannot tell whether a newer snapshot exists that the client was not shown, only that it never
// moves backwards from what it already verified. Order comes from takenAt in the snapshot format
// SnapshotVerifier accepts (yyyy-MM-ddTHH:mm:ss.fffZ, UTC); snapshot ids are content hashes and carry
// no order, so equal times with different ids are a conflict, never resolved by comparing ids.
using System;
using System.Globalization;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    public static class SnapshotOrdering
    {
        public const string TakenAtFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

        /// <param name="held">The verified snapshot the client holds, or null.</param>
        /// <param name="candidate">A verified candidate.</param>
        public static SnapshotOrder Compare(FarmSnapshot held, FarmSnapshot candidate)
        {
            if (candidate == null) throw new ArgumentNullException(nameof(candidate));
            var c = ParseTakenAt(candidate.TakenAt);
            if (held == null) return SnapshotOrder.NothingHeld;
            if (held.SnapshotId == candidate.SnapshotId) return SnapshotOrder.Identical;
            var h = ParseTakenAt(held.TakenAt);
            if (c < h) return SnapshotOrder.Older;
            if (c > h) return SnapshotOrder.Newer;
            return SnapshotOrder.Conflict;
        }

        /// <summary>Parses takenAt in the snapshot format, as UTC. Throws for anything else.</summary>
        public static DateTime ParseTakenAt(string takenAt)
        {
            if (!DateTime.TryParseExact(takenAt, TakenAtFormat, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t))
                throw new FormatException("takenAt is not in the snapshot format yyyy-MM-ddTHH:mm:ss.fffZ");
            return t;
        }
    }
}
