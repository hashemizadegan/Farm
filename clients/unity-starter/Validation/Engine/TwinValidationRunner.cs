// Validation only (not part of the runtime). Runs the Unity 6 validation cases against the sync
// fixtures (Samples/sync-a…f, built by the platform's buildFarmSnapshot), through the real
// SnapshotSync, FarmSnapshotState and SceneUpdatePlan, and a scene supplied by the caller.
// Expected drawn objects are tracked independently: a scene object is drawn when its latest state has
// Polygon or Point geometry, starting from the objects of Samples/scene.sample.json.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Scene;
using Metafarm.Twin.Core.Sync;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Validation
{
    public sealed class TwinValidationRunner
    {
        public const string SceneSample = "scene.sample.json";
        public const string Records = "sync-commitments.sample.json";
        public static readonly string[] RequiredSamples =
        {
            SceneSample, Records,
            "sync-a.content.sample.json", "sync-b.content.sample.json", "sync-c.content.sample.json",
            "sync-d.content.sample.json", "sync-e.content.sample.json", "sync-f.content.sample.json",
        };

        private readonly Func<string, string> _read;
        private readonly IValidationScene _scene;
        private readonly JObject _records;
        private readonly string _base = $"/v1/tenants/{SampleIds.TenantId}/twin";
        private HashSet<string> _expected;
        private FarmSnapshotState _state;

        /// <param name="readSample">Returns a sample's exact text by file name (for example "sync-a.content.sample.json").</param>
        public TwinValidationRunner(Func<string, string> readSample, IValidationScene scene)
        {
            _read = readSample ?? throw new ArgumentNullException(nameof(readSample));
            _scene = scene ?? throw new ArgumentNullException(nameof(scene));
            _records = JObject.Parse(_read(Records));
        }

        public async Task<IReadOnlyList<ValidationStep>> RunAsync()
        {
            var steps = new List<ValidationStep>();
            async Task Step(string name, Func<List<string>, Task> body)
            {
                var problems = new List<string>();
                try { await body(problems); }
                catch (Exception e) { problems.Add($"{e.GetType().Name}: {e.Message}"); }
                steps.Add(new ValidationStep(name, problems));
            }

            await Step("1 Load scene", async p =>
            {
                await Reset();
                Same(p, "drawn objects", _expected, _scene.DrawnObjectIds);
                p.AddRange(await _scene.CheckEngineAsync());
            });
            await Step("2 Initial A", async p =>
            {
                await SyncAndApply(p, "a", SnapshotSyncOutcome.Initial, "Place asset:7777", "Place asset:1111", "Place asset:3333");
            });
            await Step("3 Updated B (mixed diff)", async p =>
            {
                await SyncAndApply(p, "b", SnapshotSyncOutcome.Updated, "Remove asset:3333", "Refresh asset:1111", "Place asset:5555");
                Expect(p, !_scene.DrawnObjectIds.Contains(Asset('3')), "the packing shed is still drawn");
                Expect(p, _scene.DrawnObjectIds.Contains(Asset('5')), "the cold store is not drawn");
            });
            await Step("4 UpToDate (same record again)", async p =>
            {
                var (r, requests) = await Sync("b");
                Expect(p, r.Outcome == SnapshotSyncOutcome.UpToDate, $"outcome {r.Outcome}, expected UpToDate");
                Expect(p, requests == 1, $"{requests} requests, expected 1");
            });
            await Step("5 Rollback (A while holding B)", async p => await Refused(p, "a", SnapshotSyncOutcome.Rollback));
            await Step("6 Conflict (C while holding B)", async p => await Refused(p, "c", SnapshotSyncOutcome.Conflict));
            await Step("7 Asset gain (4a: D after A)", async p =>
            {
                await FromA(p);
                await SyncAndApply(p, "d", SnapshotSyncOutcome.Updated, "Place asset:2222");
            });
            await Step("8 Asset loss (4b: E after A)", async p =>
            {
                await FromA(p);
                var plan = await SyncAndApply(p, "e", SnapshotSyncOutcome.Updated, "Remove asset:1111");
                Expect(p, plan != null && plan.StateChanges.Any(s => s.Kind == StateChangeKind.Changed && s.EntityType == "plot"), "the plot is not listed as a state change");
                Expect(p, !_scene.DrawnObjectIds.Contains(Asset('1')), "the plot is still drawn");
            });
            await Step("9 Kind change (4c: F after A)", async p =>
            {
                await FromA(p);
                var plan = await SyncAndApply(p, "f", SnapshotSyncOutcome.Updated, "Refresh asset:3333");
                Expect(p, plan != null && plan.Operations.Single().EntityType == "plot", "the refresh does not carry the plot entity");
            });
            return steps;
        }

        /// <summary>The scene object id of a sample asset whose UUID repeats one digit (asset:33333333-3333-4333-8333-333333333333).</summary>
        private static string Asset(char d) =>
            $"asset:{new string(d, 8)}-{new string(d, 4)}-4{new string(d, 3)}-8{new string(d, 3)}-{new string(d, 12)}";

        private async Task Reset()
        {
            await _scene.ResetAsync();
            _state = new FarmSnapshotState(SampleIds.FarmId);
            var scene = TwinJson.Deserialize<TwinScene>(_read(SceneSample));
            _expected = new HashSet<string>(scene.Objects.Where(o => Drawable(o.Geometry)).Select(o => o.TwinObjectId), StringComparer.Ordinal);
        }

        private async Task FromA(List<string> p)
        {
            await Reset();
            await SyncAndApply(p, "a", SnapshotSyncOutcome.Initial, "Place asset:7777", "Place asset:1111", "Place asset:3333");
        }

        private async Task<(SnapshotSyncResult, int)> Sync(string name)
        {
            var rec = (JObject)_records[name].DeepClone();
            var list = new JObject { ["items"] = new JArray(rec), ["nextCursor"] = null };
            var transport = new SampleTransport()
                .Add($"{_base}/farms/{SampleIds.FarmId}/snapshots", list.ToString())
                .Add($"{_base}/snapshots/{(string)rec["id"]}/content", _read($"sync-{name}.content.sample.json"));
            var r = await new SnapshotSync(new TwinReadClient(transport, SampleIds.TenantId)).SyncAsync(_state);
            return (r, transport.Requests.Count);
        }

        private async Task<SceneUpdatePlan> SyncAndApply(List<string> p, string name, SnapshotSyncOutcome outcome, params string[] operations)
        {
            var (r, _) = await Sync(name);
            if (r.Outcome != outcome)
            {
                p.Add($"sync {name}: outcome {r.Outcome}, expected {outcome}" + (r.Problems.Count > 0 ? $" ({string.Join("; ", r.Problems)})" : ""));
                return null;
            }
            var plan = SceneUpdatePlan.From(r.Diff);
            var actual = plan.Operations.Select(o => $"{o.Kind} {o.SceneObjectId.Substring(0, 10)}").ToArray();
            Expect(p, actual.SequenceEqual(operations), $"sync {name}: operations [{string.Join(", ", actual)}], expected [{string.Join(", ", operations)}]");
            _scene.Apply(plan);
            foreach (var op in plan.Operations)
            {
                if (op.Kind != SceneOperationKind.Remove && Drawable(op.Entity.Data?["geometry"] as JObject)) _expected.Add(op.SceneObjectId);
                else _expected.Remove(op.SceneObjectId);
            }
            Same(p, $"after {name}, drawn objects", _expected, _scene.DrawnObjectIds);
            p.AddRange(await _scene.CheckEngineAsync());
            return plan;
        }

        private async Task Refused(List<string> p, string name, SnapshotSyncOutcome outcome)
        {
            var held = _state.CommitmentId;
            var drawn = new HashSet<string>(_scene.DrawnObjectIds, StringComparer.Ordinal);
            var (r, _) = await Sync(name);
            Expect(p, r.Outcome == outcome, $"outcome {r.Outcome}, expected {outcome}");
            Expect(p, r.Diff == null && !r.Accepted, "a refused candidate produced a diff");
            Expect(p, _state.CommitmentId == held, "held state changed");
            Same(p, "drawn objects", drawn, _scene.DrawnObjectIds);
        }

        private static bool Drawable(JObject geometry)
        {
            var type = (string)geometry?["type"];
            return type == "Polygon" || type == "Point";
        }

        private static void Expect(List<string> p, bool ok, string problem)
        {
            if (!ok) p.Add(problem);
        }

        private static void Same(List<string> p, string what, IEnumerable<string> expected, IEnumerable<string> actual)
        {
            var e = expected.OrderBy(x => x, StringComparer.Ordinal).ToArray();
            var a = actual.OrderBy(x => x, StringComparer.Ordinal).ToArray();
            if (!e.SequenceEqual(a)) p.Add($"{what}: [{string.Join(", ", a)}], expected [{string.Join(", ", e)}]");
        }
    }
}
