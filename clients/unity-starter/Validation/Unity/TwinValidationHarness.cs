// Validation only: compiled only when the METAFARM_TWIN_VALIDATION scripting define is set (see
// Metafarm.Twin.Validation.asmdef), never part of the runtime. Runs TwinValidationRunner against a real
// FarmSceneLoader: each scenario gets a fresh loader GameObject, and after every change the drawn
// objects are checked on the next frame (Destroy is deferred). Results go to the Console / Player.log
// as lines starting with "TWIN-VALIDATION". Reads samples only; no network, no writes.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Scene;
using Metafarm.Twin.Unity;
using UnityEngine;

namespace Metafarm.Twin.Validation
{
    public sealed class TwinValidationHarness : MonoBehaviour, IValidationScene
    {
        [Tooltip("The JSON files listed in TwinValidationRunner.RequiredSamples, imported as TextAssets.")]
        public TextAsset[] samples;
        public Material lineMaterial;
        public GameObject pointMarkerPrefab;
        [Tooltip("Run as soon as the scene starts (use this in a player build).")]
        public bool runOnStart = true;
        [Tooltip("In a player build: quit when done, exit code 0 when every step passed, 1 otherwise.")]
        public bool quitWhenDone;

        private FarmSceneLoader _loader;
        private bool _running;

        private async void Start()
        {
            if (runOnStart) await RunAll();
        }

        [ContextMenu("Run validation")]
        private async void RunFromMenu() => await RunAll();

        private async Task RunAll()
        {
            if (_running) return;
            _running = true;
            var allPassed = false;
            try
            {
                Debug.Log($"TWIN-VALIDATION START Unity {Application.unityVersion}, {Application.platform}, {(Application.isEditor ? "Editor" : "Player")}");
                var missing = TwinValidationRunner.RequiredSamples.Where(f => Find(f) == null).ToList();
                if (missing.Count > 0)
                {
                    Debug.LogError($"TWIN-VALIDATION FAIL setup: missing samples {string.Join(", ", missing)}");
                    return;
                }
                var steps = await new TwinValidationRunner(ReadSample, this).RunAsync();
                foreach (var s in steps)
                {
                    if (s.Passed) Debug.Log(s.ToString());
                    else Debug.LogError(s.ToString());
                }
                allPassed = steps.All(s => s.Passed);
                Debug.Log($"TWIN-VALIDATION {(allPassed ? "ALL PASSED" : "FAILED")} ({steps.Count(s => s.Passed)}/{steps.Count})");
            }
            catch (Exception e)
            {
                Debug.LogError($"TWIN-VALIDATION FAIL exception: {e}");
            }
            finally
            {
                _running = false;
                if (quitWhenDone && !Application.isEditor) Application.Quit(allPassed ? 0 : 1);
            }
        }

        private TextAsset Find(string fileName)
        {
            // Unity names a TextAsset after the file without its last extension.
            var name = fileName.EndsWith(".json", StringComparison.Ordinal) ? fileName.Substring(0, fileName.Length - 5) : fileName;
            return samples?.FirstOrDefault(t => t != null && t.name == name);
        }

        private string ReadSample(string fileName) => Find(fileName)?.text ?? throw new InvalidOperationException($"sample {fileName} is not assigned");

        // IValidationScene

        public async Task ResetAsync()
        {
            if (_loader != null) Destroy(_loader.gameObject);
            await Awaitable.NextFrameAsync();
            var go = new GameObject("TwinValidationScene");
            go.transform.SetParent(transform, false);
            _loader = go.AddComponent<FarmSceneLoader>();
            _loader.lineMaterial = lineMaterial;
            _loader.pointMarkerPrefab = pointMarkerPrefab;
            var transport = new SampleTransport().Add($"/v1/tenants/{SampleIds.TenantId}/twin/farms/{SampleIds.FarmId}/scene", ReadSample(TwinValidationRunner.SceneSample));
            await _loader.Load(new TwinReadClient(transport, SampleIds.TenantId), SampleIds.FarmId);
        }

        public void Apply(SceneUpdatePlan plan) => _loader.ApplySnapshotPlan(plan);

        public IReadOnlyCollection<string> DrawnObjectIds => _loader.DrawnObjectIds;

        public async Task<IReadOnlyList<string>> CheckEngineAsync()
        {
            await Awaitable.NextFrameAsync(); // let deferred Destroy calls complete
            var problems = new List<string>();
            var children = new List<Transform>();
            foreach (Transform child in _loader.transform) children.Add(child);
            var objects = children.Where(c => c.name != "Boundary").ToList();
            if (objects.Count != _loader.DrawnObjectIds.Count)
                problems.Add($"{objects.Count} drawn GameObjects under the loader, but {_loader.DrawnObjectIds.Count} tracked ids");
            var markers = objects.Select(c => c.name).Where(n => n.EndsWith("]", StringComparison.Ordinal)).ToList();
            foreach (var dup in markers.GroupBy(n => n).Where(g => g.Count() > 1))
                problems.Add($"duplicate marker GameObject {dup.Key}");
            if (children.Count(c => c.name == "Boundary") != 1) problems.Add("the farm boundary is not drawn exactly once");
            return problems;
        }
    }
}
