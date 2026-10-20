// Metres around the farm origin, the same convention as packages/map-scene/src/core/local-frame.ts:
// +x = east, +z = north in Unity (three.js uses -z for north; Unity is left-handed, so +z = north).
// Equirectangular approximation: fine for a few kilometres of visualisation, not a survey projection.
using UnityEngine;

namespace Metafarm.Twin.Scene
{
    public readonly struct LocalFrame
    {
        private const double MetresPerDegLat = 111_320.0;
        private readonly double _lon, _lat, _cosLat;

        public LocalFrame(double originLon, double originLat)
        {
            _lon = originLon;
            _lat = originLat;
            _cosLat = System.Math.Cos(originLat * System.Math.PI / 180.0);
        }

        public Vector3 ToLocal(double lon, double lat, float height = 0f)
        {
            var east = (lon - _lon) * MetresPerDegLat * _cosLat;
            var north = (lat - _lat) * MetresPerDegLat;
            return new Vector3((float)east, height, (float)north);
        }
    }
}
