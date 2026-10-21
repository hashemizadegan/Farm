// First client milestone: load a farm's twin scene and draw placeholders (boundary, plot outlines,
// point markers). Offline it reads the sample JSON through SampleTransport; online, call Load with a
// TwinReadClient over UnityWebRequestTransport. Read-only: no wallet, no signing, no writes.
// ApplySnapshotPlan executes a SceneUpdatePlan (decided and tested in the engine-free core) after a
// verified SnapshotSync; this class only draws and removes objects.
using System.Collections.Generic;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Scene;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Metafarm.Twin.Unity
{
    public sealed class FarmSceneLoader : MonoBehaviour
    {
        [Tooltip("Samples/scene.sample.json, to render without a server. Leave empty to call Load yourself.")]
        public TextAsset sampleScene;
        public Material lineMaterial;
        public GameObject pointMarkerPrefab;

        private readonly Dictionary<string, TwinObject> _objects = new Dictionary<string, TwinObject>();
        // What is drawn, by twin object id (asset:<id>), so a snapshot update can redraw or remove it.
        private readonly Dictionary<string, GameObject> _drawn = new Dictionary<string, GameObject>();

        public IReadOnlyDictionary<string, TwinObject> Objects => _objects;
        /// <summary>The twin object ids currently drawn (read-only; used by the validation harness).</summary>
        public IReadOnlyCollection<string> DrawnObjectIds => _drawn.Keys;

        private async void Start()
        {
            if (sampleScene == null) return;
            var transport = new SampleTransport().Add($"/v1/tenants/{SampleIds.TenantId}/twin/farms/{SampleIds.FarmId}/scene", sampleScene.text);
            await Load(new TwinReadClient(transport, SampleIds.TenantId), SampleIds.FarmId);
        }

        /// <summary>Loads every page of a farm's scene and draws it.</summary>
        public async Task Load(ITwinReadApi api, string farmId)
        {
            string cursor = null;
            do
            {
                var scene = await api.GetSceneAsync(farmId, cursor);
                if (scene.Scheme != TwinScene.Scheme1)
                {
                    Debug.LogError($"Unsupported scene scheme '{scene.Scheme}'");
                    return;
                }
                Render(scene, drawFarm: cursor == null);
                cursor = scene.NextCursor;
            } while (cursor != null);
        }

        private LocalFrame? _frame;

        private void Render(TwinScene scene, bool drawFarm)
        {
            if (_frame == null)
            {
                var origin = scene.Farm.Origin ?? FirstPoint(scene.Farm.Outline);
                if (origin == null)
                {
                    Debug.LogWarning($"Farm '{scene.Farm.Name}' has no origin or boundary yet");
                    return;
                }
                _frame = new LocalFrame(origin.Lon, origin.Lat);
            }
            var frame = _frame.Value;
            if (drawFarm)
            {
                if (scene.Farm.Outline != null) DrawRing("Boundary", scene.Farm.Outline, frame, Color.white);
                foreach (var layer in scene.Redacted) Debug.Log($"Layer withheld for this account: {layer}");
            }
            foreach (var o in scene.Objects)
            {
                _objects[o.TwinObjectId] = o;
                // Objects without geometry (e.g. a storage unit not yet placed) are listed in Objects, not drawn.
                Redraw(o.TwinObjectId, o.Name, o.Geometry, ColorFor(o.Layer), frame);
            }
        }

        /// <summary>
        /// Applies a plan from SceneUpdatePlan.From(result.Diff) after SnapshotSync accepted a snapshot.
        /// Remove destroys the object; Refresh and Place redraw it from the entity's verified state.
        /// </summary>
        public void ApplySnapshotPlan(SceneUpdatePlan plan)
        {
            if (plan == null) return;
            if (_frame == null)
            {
                Debug.LogWarning("Load the farm scene before applying snapshot updates (no local frame yet)");
                return;
            }
            var frame = _frame.Value;
            foreach (var op in plan.Operations)
            {
                if (op.Kind == SceneOperationKind.Remove)
                {
                    Erase(op.SceneObjectId);
                    _objects.Remove(op.SceneObjectId);
                    continue;
                }
                var label = (string)op.Entity.Data?["name"] ?? op.EntityId;
                Redraw(op.SceneObjectId, label, op.Entity.Data?["geometry"] as JObject, ColorForEntity(op.EntityType), frame);
            }
            foreach (var change in plan.StateChanges) Debug.Log($"Farm state {change.Kind}: {change.EntityType} {change.EntityId}");
        }

        private void Redraw(string objectId, string objectName, JObject geometry, Color color, LocalFrame frame)
        {
            Erase(objectId);
            var type = (string)geometry?["type"];
            GameObject drawn = null;
            if (type == "Polygon") drawn = DrawRing(objectName, ToPairs(geometry["coordinates"]?[0]), frame, color);
            else if (type == "Point") drawn = PlaceMarker(objectId, objectName, geometry, frame);
            if (drawn != null) _drawn[objectId] = drawn;
        }

        private void Erase(string objectId)
        {
            if (_drawn.TryGetValue(objectId, out var old))
            {
                if (old != null) Destroy(old);
                _drawn.Remove(objectId);
            }
        }

        private GameObject DrawRing(string objectName, List<double[]> ring, LocalFrame frame, Color color)
        {
            if (ring == null || ring.Count < 2) return null;
            var go = new GameObject(objectName);
            go.transform.SetParent(transform, false);
            var line = go.AddComponent<LineRenderer>();
            line.useWorldSpace = false;
            line.positionCount = ring.Count;
            for (var i = 0; i < ring.Count; i++) line.SetPosition(i, frame.ToLocal(ring[i][0], ring[i][1], 0.05f));
            line.widthMultiplier = 0.3f;
            line.startColor = color;
            line.endColor = color;
            if (lineMaterial != null) line.material = lineMaterial;
            return go;
        }

        private GameObject PlaceMarker(string objectId, string objectName, JObject geometry, LocalFrame frame)
        {
            var c = geometry["coordinates"];
            if (c == null) return null;
            var marker = pointMarkerPrefab != null ? Instantiate(pointMarkerPrefab) : GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            marker.name = $"{objectName} [{objectId}]";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = frame.ToLocal((double)c[0], (double)c[1]);
            return marker;
        }

        private static List<double[]> ToPairs(JToken ring)
        {
            var list = new List<double[]>();
            if (ring == null) return list;
            foreach (var p in ring) list.Add(new[] { (double)p[0], (double)p[1] });
            return list;
        }

        private static LonLat FirstPoint(List<double[]> outline) =>
            outline != null && outline.Count > 0 ? new LonLat { Lon = outline[0][0], Lat = outline[0][1] } : null;

        private static Color ColorForEntity(string entityType)
        {
            switch (entityType)
            {
                case "plot": return ColorFor("plots");
                case "structure": return ColorFor("buildings");
                default: return Color.gray;
            }
        }

        private static Color ColorFor(string layer)
        {
            switch (layer)
            {
                case "plots": return new Color(0.55f, 0.75f, 0.35f);
                case "buildings": return new Color(0.8f, 0.6f, 0.4f);
                case "storage": return new Color(0.4f, 0.6f, 0.85f);
                default: return Color.gray;
            }
        }
    }
}
