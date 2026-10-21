using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Scene
{
    /// <summary>A change to farm state that has no scene object (machines from the equipment register, crop seasons, stock).</summary>
    public sealed class StateChange
    {
        internal StateChange(StateChangeKind kind, SnapshotEntity entity)
        {
            Kind = kind;
            EntityType = entity.Type;
            EntityId = entity.Id;
            Entity = entity;
        }

        public StateChangeKind Kind { get; }
        public string EntityType { get; }
        public string EntityId { get; }
        /// <summary>The new state, or the last state for Removed.</summary>
        public SnapshotEntity Entity { get; }
    }
}
