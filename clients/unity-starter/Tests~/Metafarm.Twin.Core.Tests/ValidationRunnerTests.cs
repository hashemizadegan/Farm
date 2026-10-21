using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Scene;
using Metafarm.Twin.Validation;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>
    /// The Unity 6 validation runner, driven against a model scene. This checks the runner, the
    /// sync-a…f fixtures and the expected outcomes; it does not validate FarmSceneLoader in Unity.
    /// </summary>
    public class ValidationRunnerTests
    {
        /// <summary>Mirrors FarmSceneLoader's rules: Remove erases; Refresh/Place draw when the geometry is a Polygon or Point.</summary>
        private class ModelScene : IValidationScene
        {
            protected readonly HashSet<string> Drawn = new HashSet<string>(StringComparer.Ordinal);

            public Task ResetAsync()
            {
                Drawn.Clear();
                foreach (var o in TwinJson.Deserialize<TwinScene>(Samples.Read(TwinValidationRunner.SceneSample)).Objects)
                    if (Drawable(o.Geometry)) Drawn.Add(o.TwinObjectId);
                return Task.CompletedTask;
            }

            public virtual void Apply(SceneUpdatePlan plan)
            {
                foreach (var op in plan.Operations)
                {
                    if (op.Kind != SceneOperationKind.Remove && Drawable(op.Entity.Data?["geometry"] as JObject)) Drawn.Add(op.SceneObjectId);
                    else Drawn.Remove(op.SceneObjectId);
                }
            }

            public IReadOnlyCollection<string> DrawnObjectIds => Drawn;
            public Task<IReadOnlyList<string>> CheckEngineAsync() => Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());

            private static bool Drawable(JObject g) => (string)g?["type"] == "Polygon" || (string)g?["type"] == "Point";
        }

        /// <summary>An adapter bug: it never removes anything.</summary>
        private sealed class IgnoresRemovals : ModelScene
        {
            public override void Apply(SceneUpdatePlan plan)
            {
                foreach (var op in plan.Operations.Where(o => o.Kind != SceneOperationKind.Remove))
                    if (op.Entity.Data?["geometry"] is JObject) Drawn.Add(op.SceneObjectId);
            }
        }

        [Fact]
        public async Task EveryValidationStepPassesAgainstTheModelScene()
        {
            var steps = await new TwinValidationRunner(Samples.Read, new ModelScene()).RunAsync();
            Assert.Equal(
                new[] { "1 Load scene", "2 Initial A", "3 Updated B (mixed diff)", "4 UpToDate (same record again)", "5 Rollback (A while holding B)",
                        "6 Conflict (C while holding B)", "7 Asset gain (4a: D after A)", "8 Asset loss (4b: E after A)", "9 Kind change (4c: F after A)" },
                steps.Select(s => s.Name));
            Assert.All(steps, s => Assert.True(s.Passed, s.ToString()));
        }

        [Fact]
        public async Task TheRunnerCatchesAnAdapterThatLeavesRemovedObjectsDrawn()
        {
            var steps = await new TwinValidationRunner(Samples.Read, new IgnoresRemovals()).RunAsync();
            var failed = steps.Where(s => !s.Passed).Select(s => s.Name).ToArray();
            Assert.Contains("3 Updated B (mixed diff)", failed);
            Assert.Contains("8 Asset loss (4b: E after A)", failed);
            Assert.StartsWith("TWIN-VALIDATION FAIL 3 Updated B", steps.Single(s => s.Name.StartsWith("3 ")).ToString());
        }

        [Fact]
        public void EveryRequiredSampleShipsWithTheStarter()
        {
            foreach (var f in TwinValidationRunner.RequiredSamples)
                Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "Samples", f)), $"missing sample {f}");
        }
    }
}
