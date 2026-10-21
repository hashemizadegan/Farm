namespace Metafarm.Twin.Core.Sync
{
    /// <summary>Why a snapshot candidate failed verification. Ordering outcomes (rollback, conflict) are not failures.</summary>
    public enum SnapshotFailure
    {
        None,
        /// <summary>The record is missing or is not a farm-snapshot commitment.</summary>
        NotASnapshotRecord,
        /// <summary>The record or the snapshot belongs to another farm than the one requested.</summary>
        FarmMismatch,
        /// <summary>The bytes could not be fetched (the API answered with an error; see the problems).</summary>
        ContentUnavailable,
        /// <summary>SHA-256 of the received bytes is not the record's content hash.</summary>
        ContentMismatch,
        /// <summary>The bytes match the hash but are not a readable snapshot.</summary>
        Unreadable,
        /// <summary>Entity order, the Merkle root over the entity hashes, or the snapshot id does not check out.</summary>
        StructureInvalid,
    }
}
