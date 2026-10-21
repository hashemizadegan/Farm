namespace Metafarm.Twin.Core.Sync
{
    public enum SnapshotSyncOutcome
    {
        /// <summary>The farm has no recorded snapshot yet.</summary>
        NoSnapshot,
        /// <summary>The newest record is the one the client holds; nothing was fetched.</summary>
        UpToDate,
        /// <summary>The candidate verified and is the snapshot the client already holds.</summary>
        Unchanged,
        /// <summary>First sync: the candidate verified and is now held; the diff adds every entity.</summary>
        Initial,
        /// <summary>A later snapshot verified and is now held; the diff says what changed (it may be empty).</summary>
        Updated,
        /// <summary>The candidate failed verification (see Failure); held state is unchanged.</summary>
        VerificationFailed,
        /// <summary>The record or snapshot is for another farm than the one requested; held state is unchanged.</summary>
        FarmMismatch,
        /// <summary>The candidate verified but was taken earlier than the held snapshot; held state is unchanged.</summary>
        Rollback,
        /// <summary>The candidate verified and has the held snapshot's takenAt but different content; held state is unchanged.</summary>
        Conflict,
    }
}
