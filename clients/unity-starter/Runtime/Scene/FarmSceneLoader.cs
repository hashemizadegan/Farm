// First client milestone: load a farm's twin scene (from the API, or from a sample JSON asset for
// offline work) and draw the boundary, plots and point assets as placeholders. No gameplay, physics
// or multiplayer; nothing here changes data or touches a wallet.
using System.Collections.Generic;
using Metafarm.Twin.Api;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Metafarm.Twin.Scene
{
    public sealed class FarmSceneLoader : MonoBehaviour
    {
        [Tooltip("Optional: a sample scene (Samples/scene.sample.json) to render without a server.")]
        public TextAsset sampleScene;
        public Material lineMaterial;
        public GameObject pointMarkerPrefab;

        private readonly Dictionary<string, TwinObject> _byObjectId = new();

        private void Start()
        {
            if (sampleScene != null) Render(JsonConvert.DeserializeObject<TwinScene>(sampleScene.text));
        }

        /// Call with a scene fetched by TwinApiClient.GetSceneAsync (follow NextCursor for more objects).
        public void Render(TwinScene scene)
        {
            if (scene == null || scene.Scheme != "metafarm-twin-scene/1")
            {
                Debug.LogError("Not a metafarm-twin-scene/1 document");
                return;
            }
            var origin = scene.Farm.Origin ?? FirstPoint(scene.Farm.Outline);
            if (origin == null)
            {
                Debug.LogWarning($"Farm {scene.Farm.Name} has no origin or boundary yet");
                return;
            }
            var frame = new LocalFrame(origin.Lon, origin.Lat);
            if (scene.Farm.Outline != null) DrawRing("Boundary", scene.Farm.Outline, frame, Color.white);
            foreach (var layer in scene.Redacted) Debug.Log($"Layer withheld for this account: {layer}");

            foreach (var o in scene.Objects)
            {
                _byObjectId[o.TwinObjectId] = o;
                var type = (string)o.Geometry?["type"];
                if (type == "Polygon") DrawRing(o.Name, ToPairs(o.Geometry["coordinates"]?[0]), frame, ColorFor(o.Layer));
                else if (type == "Point") PlaceMarker(o, frame);
                // Objects without geometry (e.g. a storage unit not yet placed) are listed, not drawn.
            }
        }

        public bool TryGetObject(string twinObjectId, out TwinObject o) => _byObjectId.TryGetValue(twinObjectId, out o);

        private void DrawRing(string name, List<double[]> ring, LocalFrame frame, Color color)
        {
            if (ring == null || ring.Count < 2) return;
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            var line = go.AddComponent<LineRenderer>();
            line.positionCount = ring.Count;
            for (var i = 0; i < ring.Count; i++) line.SetPosition(i, frame.ToLocal(ring[i][0], ring[i][1], 0.05f));
            line.widthMultiplier = 0.3f;
            line.startColor = line.endColor = color;
            if (lineMaterial != null) line.material = lineMaterial;
        }

        private void PlaceMarker(TwinObject o, LocalFrame frame)
        {
            var c = o.Geometry["coordinates"];
            var pos = frame.ToLocal((double)c[0], (double)c[1]);
            var marker = pointMarkerPrefab != null ? Instantiate(pointMarkerPrefab, transform) : GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            marker.name = $"{o.Name} [{o.TwinObjectId}]";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = pos;
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

        private static Color ColorFor(string layer) => layer switch
        {
            "plots" => new Color(0.55f, 0.75f, 0.35f),
            "buildings" => new Color(0.8f, 0.6f, 0.4f),
            "storage" => new Color(0.4f, 0.6f, 0.85f),
            _ => Color.gray,
        };
    }
}
