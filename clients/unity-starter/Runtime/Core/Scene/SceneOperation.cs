using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Scene
{
    /// <summary>One change for the scene, keyed by the twin object id the scene endpoint uses (asset:&lt;id&gt;).</summary>
    public sealed class SceneOperation
    {
        internal SceneOperation(SceneOperationKind kind, string sceneObjectId, SnapshotEntity entity)
        {
            Kind = kind;
            SceneObjectId = sceneObjectId;
            EntityType = entity.Type;
            EntityId = entity.Id;
            Entity = kind == SceneOperationKind.Remove ? null : entity;
        }

        public SceneOperationKind Kind { get; }
        public string SceneObjectId { get; }
        public string EntityType { get; }
        public string EntityId { get; }
        /// <summary>The entity's new state (name, geometry, …); null for Remove.</summary>
        public SnapshotEntity Entity { get; }
    }
}
