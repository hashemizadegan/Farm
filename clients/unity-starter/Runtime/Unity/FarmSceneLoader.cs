// First client milestone: load a farm's twin scene and draw placeholders (boundary, plot outlines,
// point markers). Offline it reads the sample JSON through SampleTransport; online, call Load with a
// TwinReadClient over UnityWebRequestTransport. Read-only: no wallet, no signing, no writes.
using System.Collections.Generic;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
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

        public IReadOnlyDictionary<string, TwinObject> Objects => _objects;

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
                var type = (string)o.Geometry?["type"];
                if (type == "Polygon") DrawRing(o.Name, ToPairs(o.Geometry["coordinates"]?[0]), frame, ColorFor(o.Layer));
                else if (type == "Point") PlaceMarker(o, frame);
                // Objects without geometry (e.g. a storage unit not yet placed) are listed in Objects, not drawn.
            }
        }

        private void DrawRing(string objectName, List<double[]> ring, LocalFrame frame, Color color)
        {
            if (ring == null || ring.Count < 2) return;
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
        }

        private void PlaceMarker(TwinObject o, LocalFrame frame)
        {
            var c = o.Geometry["coordinates"];
            var marker = pointMarkerPrefab != null ? Instantiate(pointMarkerPrefab) : GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            marker.name = $"{o.Name} [{o.TwinObjectId}]";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = frame.ToLocal((double)c[0], (double)c[1]);
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
