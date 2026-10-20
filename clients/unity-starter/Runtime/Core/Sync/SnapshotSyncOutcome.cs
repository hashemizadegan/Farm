namespace Metafarm.Twin.Core.Sync
{
    public enum SnapshotSyncOutcome
    {
        /// <summary>The farm has no recorded snapshot yet.</summary>
        NoSnapshot,
        /// <summary>The client already holds the newest snapshot.</summary>
        UpToDate,
        /// <summary>A newer snapshot was fetched and passed both the server's and the client's checks.</summary>
        Updated,
        /// <summary>A newer snapshot exists but failed verification; keep the old one and report it.</summary>
        VerificationFailed,
    }
}
