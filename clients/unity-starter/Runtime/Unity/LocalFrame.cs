// Metres around the farm origin, matching packages/map-scene/src/core/local-frame.ts (equirectangular,
// 111 320 m per degree of latitude). Unity is left-handed with +y up, so +x = east and +z = north
// (three.js uses -z for north). For visualisation only, not surveying.
using UnityEngine;

namespace Metafarm.Twin.Unity
{
    public readonly struct LocalFrame
    {
        private const double MetresPerDegLat = 111_320.0;
        private readonly double _originLon;
        private readonly double _originLat;
        private readonly double _cosLat;

        public LocalFrame(double originLon, double originLat)
        {
            _originLon = originLon;
            _originLat = originLat;
            _cosLat = System.Math.Cos(originLat * System.Math.PI / 180.0);
        }

        public Vector3 ToLocal(double lon, double lat, float height = 0f)
        {
            var east = (lon - _originLon) * MetresPerDegLat * _cosLat;
            var north = (lat - _originLat) * MetresPerDegLat;
            return new Vector3((float)east, height, (float)north);
        }
    }
}
