using System;
using System.Linq;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Scene;
using Metafarm.Twin.Core.Sync;
using Metafarm.Twin.Core.Verification;
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
    }
}
