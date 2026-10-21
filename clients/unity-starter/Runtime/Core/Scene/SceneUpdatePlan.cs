// Turns a verified snapshot diff into what the scene should do, without any engine code, so the
// decisions are unit-tested and the Unity layer only executes them.
// - Entities recorded from the asset registry (data.source = "business_asset") are scene objects,
//   keyed asset:<id> exactly like GET …/farms/{id}/scene's twinObjectId.
// - Everything else (equipment register, crop seasons, stock) is farm state without a scene object
//   and is listed in StateChanges for panels and labels.
// - Operations are ordered Remove, then Refresh, then Place; within each, in the diff's (type, id) order.
using System;
using System.Collections.Generic;
using System.Linq;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Sync;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Core.Scene
{
    public sealed class SceneUpdatePlan
    {
        public const string SceneSource = "business_asset";

        private SceneUpdatePlan(List<SceneOperation> operations, List<StateChange> stateChanges)
        {
            Operations = operations;
            StateChanges = stateChanges;
        }

        public IReadOnlyList<SceneOperation> Operations { get; }
        public IReadOnlyList<StateChange> StateChanges { get; }
        public bool IsEmpty => Operations.Count == 0 && StateChanges.Count == 0;

        /// <summary>The scene object id for an entity, or null when it has none.</summary>
        public static string SceneObjectIdOf(SnapshotEntity e)
        {
            var source = e?.Data?["source"];
            return source != null && source.Type == JTokenType.String && (string)source == SceneSource ? "asset:" + e.Id : null;
        }

        /// <summary>The plan for a diff from SnapshotSync (Initial or Updated). A first sync places every scene object.</summary>
        public static SceneUpdatePlan From(SnapshotDiff diff)
        {
            if (diff == null) throw new ArgumentNullException(nameof(diff));
            var remove = new List<SceneOperation>();
            var refresh = new List<SceneOperation>();
            var place = new List<SceneOperation>();
            var state = new List<StateChange>();

            foreach (var e in diff.Removed)
            {
                var id = SceneObjectIdOf(e);
                if (id != null) remove.Add(new SceneOperation(SceneOperationKind.Remove, id, e));
                else state.Add(new StateChange(StateChangeKind.Removed, e));
            }
            foreach (var c in diff.Changed)
            {
                var before = SceneObjectIdOf(c.Before);
                var after = SceneObjectIdOf(c.After);
                if (before != null && after != null) refresh.Add(new SceneOperation(SceneOperationKind.Refresh, after, c.After));
                else if (after != null) place.Add(new SceneOperation(SceneOperationKind.Place, after, c.After));
                else
                {
                    if (before != null) remove.Add(new SceneOperation(SceneOperationKind.Remove, before, c.Before));
                    state.Add(new StateChange(StateChangeKind.Changed, c.After));
                }
            }
            foreach (var e in diff.Added)
            {
                var id = SceneObjectIdOf(e);
                if (id != null) place.Add(new SceneOperation(SceneOperationKind.Place, id, e));
                else state.Add(new StateChange(StateChangeKind.Added, e));
            }

            var operations = Ordered(remove).Concat(Ordered(refresh)).Concat(Ordered(place)).ToList();
            var stateChanges = state.OrderBy(s => SnapshotDiff.Key(s.EntityType, s.EntityId), StringComparer.Ordinal).ToList();
            return new SceneUpdatePlan(operations, stateChanges);
        }

        private static IEnumerable<SceneOperation> Ordered(IEnumerable<SceneOperation> ops) =>
            ops.OrderBy(o => SnapshotDiff.Key(o.EntityType, o.EntityId), StringComparer.Ordinal);
    }
}
