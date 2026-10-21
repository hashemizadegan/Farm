using System;
using System.Collections.Generic;
using System.Linq;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Scene;
using Metafarm.Twin.Core.Sync;
using Metafarm.Twin.Core.Verification;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    public class SceneUpdatePlanTests
    {
        private static FarmSnapshot Load(string name) => TwinJson.Deserialize<FarmSnapshot>(Samples.Read($"sync-{name}.content.sample.json"));

        private static string[] Ops(SceneUpdatePlan p) => p.Operations.Select(o => $"{o.Kind} {o.SceneObjectId.Substring(0, 10)}").ToArray();
        private static string[] States(SceneUpdatePlan p) => p.StateChanges.Select(s => $"{s.Kind} {s.EntityType}/{s.EntityId.Substring(0, 4)}").ToArray();

        [Fact]
        public void FirstSyncPlacesEverySceneObjectAndListsTheRestAsState()
        {
            var plan = SceneUpdatePlan.From(SnapshotDiff.Between(null, Load("a")));
            Assert.Equal(new[] { "Place asset:7777", "Place asset:1111", "Place asset:3333" }, Ops(plan));
            Assert.Equal(new[] { "Added crop/6666", "Added inventory/4444", "Added machine/2222" }, States(plan));
            Assert.All(plan.Operations, o => Assert.NotNull(o.Entity));
        }

        [Fact]
        public void AMixedDiffRemovesThenRefreshesThenPlaces()
        {
            var plan = SceneUpdatePlan.From(SnapshotDiff.Between(Load("a"), Load("b")));
            Assert.Equal(new[] { "Remove asset:3333", "Refresh asset:1111", "Place asset:5555" }, Ops(plan));
            Assert.Null(plan.Operations[0].Entity);
            Assert.Equal("Block A (north)", (string)plan.Operations[1].Entity.Data["name"]);
            Assert.Equal(new[] { "Changed machine/2222" }, States(plan));
        }

        [Fact]
        public void UnchangedStateMeansNoSceneWork()
        {
            var b = Load("b");
            var diff = SnapshotDiff.Between(b, Load("b"));
            Assert.True(diff.IsEmpty);
            Assert.Equal(6, diff.UnchangedCount);
            Assert.True(SceneUpdatePlan.From(diff).IsEmpty);
        }

        [Fact]
        public void AnEntityThatLeavesTheAssetRegistryIsRemovedFromTheScene()
        {
            // Re-point the plot at another source and recommit it: new entity hash, root and snapshot id.
            var before = Load("a");
            var after = Load("a");
            var plot = after.Entities.Single(e => e.Type == "plot");
            plot.Data["source"] = "survey";
            plot.Sha256 = new string('7', 64);
            after.Root = Rfc9162CommitmentVerifier.ComputeRoot(after.Entities.Select(e => Rfc9162CommitmentVerifier.LeafHash(e.Sha256)).ToList());
            after.TakenAt = "2026-10-21T08:00:00.000Z";
            after.SnapshotId = SnapshotVerifier.HeaderId(after);
            var plan = SceneUpdatePlan.From(SnapshotDiff.Between(before, after));
            Assert.Equal(new[] { "Remove asset:1111" }, Ops(plan));
            Assert.Equal(new[] { "Changed plot/1111" }, States(plan));
        }

        [Fact]
        public void TheDiffRefusesSnapshotsThatDoNotCheckOutOrAreForAnotherFarm()
        {
            var broken = Load("b");
            broken.Root = new string('0', 64);
            Assert.Throws<ArgumentException>(() => SnapshotDiff.Between(Load("a"), broken));
            var other = Load("b");
            other.FarmId = "0f0f0f0f-0000-4000-8000-000000000000";
            other.SnapshotId = SnapshotVerifier.HeaderId(other);
            Assert.Throws<ArgumentException>(() => SnapshotDiff.Between(Load("a"), other));
        }

        /// <summary>
        /// A model scene (the set of scene object ids): Remove and Refresh need the object, Place must not
        /// find it (no duplicates). After the plan, the scene must hold exactly the new snapshot's objects.
        /// </summary>
        private static HashSet<string> ApplyToModel(HashSet<string> scene, SceneUpdatePlan plan, FarmSnapshot after)
        {
            var touched = new HashSet<string>(StringComparer.Ordinal);
            foreach (var op in plan.Operations)
            {
                Assert.True(touched.Add(op.SceneObjectId), $"{op.SceneObjectId} appears in more than one operation");
                switch (op.Kind)
                {
                    case SceneOperationKind.Remove: Assert.True(scene.Remove(op.SceneObjectId), $"removing missing {op.SceneObjectId}"); break;
                    case SceneOperationKind.Refresh: Assert.True(scene.Contains(op.SceneObjectId), $"refreshing missing {op.SceneObjectId}"); break;
                    case SceneOperationKind.Place: Assert.True(scene.Add(op.SceneObjectId), $"duplicate {op.SceneObjectId}"); break;
                }
            }
            var expected = after.Entities.Select(SceneUpdatePlan.SceneObjectIdOf).Where(id => id != null).OrderBy(x => x, StringComparer.Ordinal);
            Assert.Equal(expected, scene.OrderBy(x => x, StringComparer.Ordinal));
            return scene;
        }

        /// <summary>A recommitted variant: change entities, then re-sort and recompute root and id, as the platform would.</summary>
        private static FarmSnapshot Variant(FarmSnapshot s, string takenAt, Action<FarmSnapshot> change)
        {
            change(s);
            s.Entities = s.Entities.OrderBy(e => SnapshotDiff.Key(e.Type, e.Id), StringComparer.Ordinal).ToList();
            s.EntityCount = s.Entities.Count;
            s.Root = Rfc9162CommitmentVerifier.ComputeRoot(s.Entities.Select(e => Rfc9162CommitmentVerifier.LeafHash(e.Sha256)).ToList());
            s.TakenAt = takenAt;
            s.SnapshotId = SnapshotVerifier.HeaderId(s);
            Assert.Empty(SnapshotVerifier.CheckStructure(s));
            return s;
        }

        [Fact]
        public void InitialThenMixedDiffKeepTheModelSceneExact()
        {
            var a = Load("a");
            var scene = ApplyToModel(new HashSet<string>(StringComparer.Ordinal), SceneUpdatePlan.From(SnapshotDiff.Between(null, a)), a);
            var b = Load("b");
            ApplyToModel(scene, SceneUpdatePlan.From(SnapshotDiff.Between(a, b)), b);
        }

        [Fact]
        public void AnEntityThatGainsAnAssetReferenceIsPlaced()
        {
            var a = Load("a");
            var after = Variant(Load("a"), "2026-10-21T08:00:00.000Z", s =>
            {
                var m = s.Entities.Single(e => e.Type == "machine");
                m.Data["source"] = SceneUpdatePlan.SceneSource;
                m.Data["geometry"] = JObject.Parse("{\"type\":\"Point\",\"coordinates\":[56.0002,30.4001]}");
                m.Sha256 = new string('8', 64);
            });
            var plan = SceneUpdatePlan.From(SnapshotDiff.Between(a, after));
            Assert.Equal(new[] { "Place asset:2222" }, Ops(plan));
            Assert.Empty(plan.StateChanges);
            ApplyToModel(Initial(a), plan, after);
        }

        [Fact]
        public void AnAssetWhoseKindChangesIsRefreshedOnceNotRemovedAndPlaced()
        {
            // structure/3333 (building) becomes plot/3333 (parcel): another entity type, the same asset.
            var a = Load("a");
            var after = Variant(Load("a"), "2026-10-21T08:00:00.000Z", s =>
            {
                var shed = s.Entities.Single(e => e.Type == "structure");
                shed.Type = "plot";
                shed.Data["kind"] = "parcel";
                shed.Sha256 = new string('9', 64);
            });
            var diff = SnapshotDiff.Between(a, after);
            Assert.Equal(new[] { "plot/3333" }, diff.Added.Select(e => $"{e.Type}/{e.Id.Substring(0, 4)}"));
            Assert.Equal(new[] { "structure/3333" }, diff.Removed.Select(e => $"{e.Type}/{e.Id.Substring(0, 4)}"));
            var plan = SceneUpdatePlan.From(diff);
            Assert.Equal(new[] { "Refresh asset:3333" }, Ops(plan));
            Assert.Equal("plot", plan.Operations[0].EntityType);
            Assert.Equal("parcel", (string)plan.Operations[0].Entity.Data["kind"]);
            ApplyToModel(Initial(a), plan, after);
        }

        [Fact]
        public void AnEntityThatLosesItsAssetReferenceLeavesTheModelSceneExact()
        {
            var a = Load("a");
            var after = Variant(Load("a"), "2026-10-21T08:00:00.000Z", s =>
            {
                var plot = s.Entities.Single(e => e.Type == "plot");
                plot.Data["source"] = "survey";
                plot.Sha256 = new string('7', 64);
            });
            ApplyToModel(Initial(a), SceneUpdatePlan.From(SnapshotDiff.Between(a, after)), after);
        }

        private static HashSet<string> Initial(FarmSnapshot a) =>
            ApplyToModel(new HashSet<string>(StringComparer.Ordinal), SceneUpdatePlan.From(SnapshotDiff.Between(null, a)), a);
    }
}
