namespace Metafarm.Twin.Core.Sync
{
    /// <summary>How a verified candidate relates to the verified snapshot the client holds.</summary>
    public enum SnapshotOrder
    {
        /// <summary>The client holds nothing yet.</summary>
        NothingHeld,
        /// <summary>Taken later than the held snapshot.</summary>
        Newer,
        /// <summary>The same snapshot (same snapshot id, so the same farm, time and root).</summary>
        Identical,
        /// <summary>Taken earlier than the held snapshot: accepting it would roll the client's state back.</summary>
        Older,
        /// <summary>Taken at the same moment as the held snapshot but with different content.</summary>
        Conflict,
    }
}
