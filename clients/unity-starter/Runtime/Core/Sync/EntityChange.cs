using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    /// <summary>An entity present in both snapshots whose committed hash differs.</summary>
    public sealed class EntityChange
    {
        public EntityChange(SnapshotEntity before, SnapshotEntity after)
        {
            Before = before;
            After = after;
        }

        public SnapshotEntity Before { get; }
        public SnapshotEntity After { get; }
        public string Type => After.Type;
        public string Id => After.Id;
    }
}
